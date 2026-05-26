import axios from 'axios';
import fs from 'fs';
import path from 'path';

class ApplioClient {
    constructor(applioUrl = 'http://127.0.0.1:6969') {
        this.applioUrl = applioUrl;
        this.sessionHash = this._generateSessionHash();
        this.queue = Promise.resolve(); // Cola de ejecución secuencial
        this.fnIndex = null; // Se descubre dinámicamente
        
        // Determinar ruta de Applio desde variable de entorno o usar default
        const envRoot = process.env.APPLIO_ROOT;
        if (envRoot) {
            console.log(`📂 Usando ruta configurada para Applio: ${envRoot}`);
            this.applioRoot = envRoot;
        } else {
            console.log('⚠️ No se definió APPLIO_ROOT en .env, usando ruta por defecto: C:\\applio2\\Applio');
            this.applioRoot = 'C:\\applio2\\Applio';
        }

        if (!fs.existsSync(this.applioRoot)) {
            console.warn(`⚠️ ADVERTENCIA: La ruta de Applio '${this.applioRoot}' no existe en este PC.`);
            console.warn(`   Por favor configuara 'APPLIO_ROOT' en tu archivo .env con la ruta correcta.`);
        }

        this.outputPaths = [
            path.join(this.applioRoot, 'assets', 'audios', 'tts_rvc_output.wav'),
            path.join(this.applioRoot, 'assets', 'audios', 'tts_output.wav')
        ];
    }

    async discoverFnIndex() {
        /**
         * Descubre automáticamente el fn_index correcto para TTS+RVC
         * Estrategia:
         * 1. Consultar /config de Gradio y analizar dependencias
         * 2. Si falla, probar fn_indexes conocidos con un test real
         */
        
        // Paso 1: Intentar descubrimiento por análisis de config
        try {
            console.log('🔍 Auto-detectando fn_index para TTS+RVC...');
            const response = await axios.get(`${this.applioUrl}/config`, { timeout: 5000 });
            const config = response.data;
            
            if (config.dependencies && config.dependencies.length > 0) {
                let candidates = [];
                
                for (let i = 0; i < config.dependencies.length; i++) {
                    const dep = config.dependencies[i];
                    
                    if (!dep.inputs || !Array.isArray(dep.inputs)) continue;
                    const inputCount = dep.inputs.length;
                    
                    // Obtener labels/props de los componentes referenciados
                    let inputLabels = [];
                    for (const inputRef of dep.inputs) {
                        // inputRef puede ser un índice numérico o un objeto
                        const idx = typeof inputRef === 'number' ? inputRef : inputRef?.id;
                        if (idx !== undefined && config.components) {
                            // components puede ser un array o un objeto con ids como keys
                            const comp = Array.isArray(config.components) 
                                ? config.components[idx] 
                                : config.components[String(idx)];
                            const label = (comp?.props?.label || comp?.label || '').toLowerCase();
                            inputLabels.push(label);
                        }
                    }

                    // Criterios para identificar TTS+RVC
                    const hasTextInput = inputLabels.some(l => l.includes('text') || l.includes('input'));
                    const hasF0Method = inputLabels.some(l => l.includes('f0') || l.includes('pitch'));
                    const hasVoicePath = inputLabels.some(l => 
                        l.includes('voice') || l.includes('model') || l.includes('path') || l.includes('pth')
                    );
                    const hasTTSModel = inputLabels.some(l => l.includes('tts'));
                    const isRightSize = inputCount >= 20 && inputCount <= 30;

                    const score = (hasTextInput ? 3 : 0) + 
                                 (hasF0Method ? 3 : 0) + 
                                 (hasVoicePath ? 3 : 0) + 
                                 (hasTTSModel ? 2 : 0) +
                                 (isRightSize ? 2 : 0);

                    if (score >= 8) {
                        candidates.push({ index: i, score, inputCount });
                        console.log(`  📊 Candidato encontrado en fn_index ${i}: score=${score}, inputs=${inputCount}`);
                    }
                }

                if (candidates.length > 0) {
                    candidates.sort((a, b) => b.score - a.score);
                    const best = candidates[0];
                    console.log(`✅ fn_index detectado por config: ${best.index} (score: ${best.score})`);
                    return best.index;
                }
            }
            
            console.warn('⚠️ Análisis de config no encontró candidatos claros');
        } catch (error) {
            console.warn(`⚠️ Error leyendo /config: ${error.message}`);
        }

        // Paso 2: Probar fn_indexes conocidos con un test real
        console.log('🧪 Probando fn_indexes conocidos con audio de prueba...');
        const knownIndexes = [94, 102, 101, 95, 96, 103, 104, 100];
        
        for (const testIndex of knownIndexes) {
            try {
                const works = await this._testFnIndex(testIndex);
                if (works) {
                    console.log(`✅ fn_index ${testIndex} FUNCIONA - usando este`);
                    return testIndex;
                }
            } catch (e) {
                // Silenciar, seguir probando
            }
        }

        // Paso 3: Fallback último recurso
        console.warn('⚠️ Ningún fn_index respondió en prueba. Usando 94 como último recurso.');
        return 94;
    }

    async _testFnIndex(fnIndex) {
        /**
         * Prueba un fn_index enviando "test" y esperando hasta 45s a que aparezca un archivo
         */
        const beforeTimestamp = await this._getFileTimestamp();
        
        const testPayload = {
            data: [
                true, "", "test", "fr-FR-RemyMultilingualNeural", 0, 0, 0.75, 1, 0.5, "rmvpe",
                this.outputPaths[1], this.outputPaths[0],
                "logs\\VOCES\\RemyOriginal.pth", "", false, false, 1, false, 155, false, 0.5, "WAV", "contentvec", null, 0
            ],
            event_data: null,
            fn_index: fnIndex,
            session_hash: this._generateSessionHash(),
            trigger_id: Math.floor(Math.random() * 1000)
        };

        // Intentar enviar a los endpoints conocidos
        const endpointPaths = ['/queue/join', '/gradio_api/queue/join', '/api/queue/join'];
        let sent = false;

        for (const ep of endpointPaths) {
            try {
                await axios.post(`${this.applioUrl}${ep}`, testPayload, {
                    headers: { 'Content-Type': 'application/json' },
                    timeout: 10000
                });
                sent = true;
                console.log(`  🧪 fn_index ${fnIndex} enviado via ${ep}, esperando archivo...`);
                break;
            } catch (epErr) {
                if (epErr.response && epErr.response.status === 404) continue;
                // Otro error (conexión, etc) - asumir que endpoint no sirve
                continue;
            }
        }

        if (!sent) return false;

        // Esperar hasta 45 segundos por un archivo nuevo
        const maxWait = 45000;
        const startTime = Date.now();
        
        while (Date.now() - startTime < maxWait) {
            await new Promise(r => setTimeout(r, 2000));
            const current = await this._getFileTimestamp();
            if (current.mtime > beforeTimestamp.mtime) {
                // Verificar que tenga contenido real (>1KB)
                if (fs.existsSync(current.path) && fs.statSync(current.path).size > 1000) {
                    return true;
                }
            }
        }

        console.log(`  ❌ fn_index ${fnIndex} no generó archivo en 45s`);
        return false;
    }

    async ensureFnIndex() {
        /**
         * Asegura que fnIndex esté cargado, lo descubre si es necesario
         */
        if (this.fnIndex === null) {
            this.fnIndex = await this.discoverFnIndex();
        }
        return this.fnIndex;
    }

    _generateSessionHash() {
        const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
        let result = '';
        for (let i = 0; i < 10; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    async textToSpeech(text, outputPath, options = {}) {
        // Encadenar a la cola para asegurar ejecución secuencial estricta
        const task = this.queue.then(() => this._executeTextToSpeech(text, outputPath, options));
        
        // Actualizar la cola, manejando errores para no bloquear futuras tareas
        this.queue = task.catch(err => {
            console.error('❌ Error en cola de Applio:', err.message);
        });

        return task;
    }

    async _executeTextToSpeech(text, outputPath, options) {
        let {
            model = "fr-FR-RemyMultilingualNeural",
            speed = 0,
            pitch = 0,
            voicePath = "logs\\VOCES\\RemyOriginal.pth"
        } = options;

        // Extraer nombre del modelo (si viene como ruta)
        let rvcModelBase = path.basename(voicePath);
        
        // --- ELIMINADO: Fallback a Italia.pth (Causaba errores) ---
        // Se respeta "logs/VOCES/RemyOriginal.pth" si el usuario lo provee
        
        // NOTA: No forzamos ruta absoluta porque Applio parece preferir "logs/VOCES/..." relativo
        // Sin embargo, verificamos existencia usando la ruta absoluta para loguear advertencias.
        const absoluteVoicePath = path.isAbsolute(voicePath) 
            ? voicePath 
            : path.join(this.applioRoot, voicePath);

        // Verificar si el modelo existe
        if (!fs.existsSync(absoluteVoicePath)) {
            console.warn(`⚠️ ADVERTENCIA: El modelo RVC no se encuentra en: ${absoluteVoicePath}`);
            console.warn(`   Applio podría fallar si no encuentra el archivo.`);
            
            // Intentar buscar en subcarpetas comunes si falla
            const possiblePaths = [
                path.join(this.applioRoot, 'logs', 'VOCES', path.basename(voicePath)),
                path.join(this.applioRoot, 'logs', path.basename(voicePath)),
                path.join(this.applioRoot, 'weights', path.basename(voicePath))
            ];
            
            for (const p of possiblePaths) {
                if (fs.existsSync(p)) {
                    console.log(`✅ Modelo encontrado en ruta alternativa: ${p}`);
                    // Usamos la ruta relativa desde applioRoot para enviar al servidor, o absoluta si está fuera
                    // Para mayor seguridad según payload de usuario: usar relativa si está dentro de root
                    voicePath = path.relative(this.applioRoot, p);
                    break;
                }
            }
        }
        // Si ya era absoluta y existía, la dejamos como estaba o la convertimos a relativa si el cliente lo prefiere?
        // El usuario reportó payload exitoso con: "logs\\VOCES\\RemyOriginal.pth"
        // Así que si la ruta es absoluta y está dentro de ApplioRoot, mejor convertir a relativa.
        if (path.isAbsolute(voicePath) && voicePath.startsWith(this.applioRoot)) {
             voicePath = path.relative(this.applioRoot, voicePath);
        }

        console.log(`\n🎬 Iniciando TTS (En cola): «${text.substring(0, 100)}...»`);
        console.log(`🎛️ TTS Model: ${model}`);
        console.log(`🎤 Voice Path: ${voicePath}`);
        console.log(`🚀 Velocidad: ${speed}`);
        console.log(`🎵 Pitch: ${pitch}`);
        console.log(`🔑 Session: ${this.sessionHash}\n`);

        try {
            // Obtener timestamp del archivo antes de la solicitud
            const beforeTimestamp = await this._getFileTimestamp();
            
            // Payload ajustado para fn_index 94 (Interfaz Original - TTS+RVC)
            // Basado exactamente en el payload exitoso del usuario
            const data = [
                true,                           // 0. enable_vc
                "",                             // 1. speaker_wav
                text,                           // 2. input_text
                model,                          // 3. tts_model
                speed,                          // 4. speed
                pitch,                          // 5. pitch
                0.75,                           // 6. index_rate
                1,                              // 7. volume_envelope
                0.5,                            // 8. protect
                "rmvpe",                        // 9. f0_method
                this.outputPaths[1],            // 10. tts_output.wav path
                this.outputPaths[0],            // 11. tts_rvc_output.wav path
                voicePath,                      // 12. voice_path
                "",                             // 13. index_path
                false,                          // 14. split_audio
                false,                          // 15. autotune
                1,                              // 16. clean_audio
                false,                          // 17. 
                155,                            // 18. clean_strength
                false,                          // 19. export_format_enabled
                0.5,                            // 20. upscale_audio
                "WAV",                          // 21. export_format
                "contentvec",                   // 22. embedder_model
                null,                           // 23. custom_model
                0                               // 24. legacy
            ];

            // Asegurar que tenemos el fn_index correcto (auto-detectado o fallback a 94)
            const fnIndex = await this.ensureFnIndex();
            
            const joinPayload = {
                data: data,
                event_data: null,
                fn_index: fnIndex,
                session_hash: this.sessionHash,
                trigger_id: Math.floor(Math.random() * 1000)
            };

            console.log(`📡 Enviando a Applio (fn_index: ${fnIndex})...`);
            
            // Intentar múltiples rutas de API de Gradio (varía según versión)
            const endpointPaths = [
                '/queue/join',
                '/gradio_api/queue/join',
                '/api/queue/join'
            ];
            
            let response = null;
            let lastErr = null;
            
            for (const ep of endpointPaths) {
                try {
                    response = await axios.post(`${this.applioUrl}${ep}`, joinPayload, {
                        headers: { 'Content-Type': 'application/json' },
                        timeout: 1200000 // 20 minutos
                    });
                    console.log(`✅ Endpoint exitoso: ${ep}`);
                    break;
                } catch (epErr) {
                    lastErr = epErr;
                    if (epErr.response && epErr.response.status === 404) {
                        console.log(`   ❌ ${ep} no existe, probando siguiente...`);
                        continue;
                    }
                    // Si no es 404, es otro error (timeout, conexión) - no seguir probando
                    throw epErr;
                }
            }
            
            if (!response) {
                throw lastErr || new Error('No se pudo conectar a ningún endpoint de Gradio');
            }

            console.log('✅ Solicitud enviada');
            console.log(`📋 Event ID: ${response.data.event_id}`);

            // Esperar el archivo nuevo y copiarlo al destino
            return await this._waitForNewFile(beforeTimestamp, outputPath);

        } catch (error) {
            console.error('❌ Error:', error.message);
            throw error;
        }
    }

    async _getFileTimestamp() {
        // Usar las rutas configuradas en el constructor
        const paths = this.outputPaths;

        for (const filePath of paths) {
            if (fs.existsSync(filePath)) {
                const stats = fs.statSync(filePath);
                return { path: filePath, mtime: stats.mtime.getTime() };
            }
        }
        return { path: paths[0], mtime: 0 };
    }

    async _waitForNewFile(beforeTimestamp, outputPath) {
        console.log('⏳ Esperando generación...');
        
        const startTime = Date.now();
        const timeout = 1200000; // 20 minutos

        return new Promise((resolve, reject) => {
            const checkFile = async () => {
                try {
                    if (Date.now() - startTime > timeout) {
                        reject(new Error('Timeout: Applio tardó demasiado'));
                        return;
                    }

                    const current = await this._getFileTimestamp();
                    
                    // Verificar si hay un archivo nuevo
                    if (current.mtime > beforeTimestamp.mtime) {
                        console.log('🎯 ¡Archivo nuevo detectado!');
                        
                        // Esperar un poco para que termine de escribirse completamente (evitar archivos corruptos o incompletos)
                        console.log('⏳ Esperando 3s para asegurar escritura completa...');
                        await new Promise(r => setTimeout(r, 3000));
                        
                        // Verificar que el archivo existe y tiene contenido
                        if (fs.existsSync(current.path)) {
                            const stats = fs.statSync(current.path);
                            
                            if (stats.size > 1000) { // Al menos 1KB
                                console.log(`📊 Archivo válido: ${(stats.size / 1024).toFixed(1)} KB`);
                                
                                // Asegurar que el directorio de destino existe
                                const destDir = path.dirname(outputPath);
                                if (!fs.existsSync(destDir)) {
                                    fs.mkdirSync(destDir, { recursive: true });
                                }

                                // Copiar al destino
                                fs.copyFileSync(current.path, outputPath);
                                const finalStats = fs.statSync(outputPath);

                                console.log(`✅ Guardado: ${outputPath}`);

                                resolve({
                                    success: true,
                                    filePath: outputPath,
                                    size: finalStats.size,
                                    sourcePath: current.path
                                });
                                return;
                            }
                        }
                    }

                    // Seguir verificando
                    setTimeout(checkFile, 1000);

                } catch (error) {
                    reject(error);
                }
            };

            // Empezar a verificar después de 2 segundos
            setTimeout(checkFile, 2000);
        });
    }

    async checkConnection() {
        try {
            console.log('🔍 Verificando Applio...');
            await axios.get(`${this.applioUrl}/`, { timeout: 5000 });
            console.log('✅ Conectado');
            
            // Auto-detectar fn_index cuando se conecta por primera vez
            if (this.fnIndex === null) {
                await this.ensureFnIndex();
            }
            
            return true;
        } catch (error) {
            console.error('❌ Applio no disponible en puerto 6969');
            return false;
        }
    }
}

export default ApplioClient;