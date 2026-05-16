document.addEventListener('DOMContentLoaded', () => {
    console.log('Video Translator Loaded');

// --- Persistent State DB System ---
window.InitTranslatorDB = function() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('TranslatorCacheDB', 1);
        request.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains('files')) {
                db.createObjectStore('files');
            }
        };
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror = (e) => reject(e.target.error);
    });
};

window.saveToDB = async function(storeName, key, value) {
    try {
        const db = await window.InitTranslatorDB();
        const tx = db.transaction(storeName, 'readwrite');
        tx.objectStore(storeName).put(value, key);
        return tx.complete;
    } catch(e) { console.error('DB Save error', e); }
};

window.getFromDB = async function(storeName, key) {
    try {
        const db = await window.InitTranslatorDB();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, 'readonly');
            const req = tx.objectStore(storeName).get(key);
            req.onsuccess = () => resolve(req.result);
            req.onerror = (e) => reject(e.target.error);
        });
    } catch(e) { console.error('DB Get error', e); }
};



    // Inicializar estado
    window.switchTab('auto');
    window.toggleVoiceSelect();
    loadPreferences();
    loadOutputDir();

    // Group Size slider
    const groupSlider = document.getElementById('groupSizeSlider');
    const groupValue = document.getElementById('groupSizeValue');
    const GROUP_SIZE_MAP = [1, 3, 6, 9, 12];
    if (groupSlider && groupValue) {
        groupSlider.addEventListener('input', () => {
            groupValue.textContent = GROUP_SIZE_MAP[groupSlider.value];
        });
    }

    // Setup Dropzones for Auto Mode
    setupDropZone('videoDropZone', 'videoUpload', 'videoFileName', 'video', () => updateGenerateButton());
    setupDropZone('musicDropZone', 'musicUpload', 'musicFileName', 'audio');

    // Setup Dropzones for Manual Mode
    setupDropZone('dropZone_manual_video', 'videoUploadManual', 'fileName_manual_video', 'video', () => updateGenerateButton());
    setupDropZone('dropZone_manual_music', 'musicUploadManual', 'fileName_manual_music', 'audio');

    ['es', 'en', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ko', 'ja'].forEach(lang => {
        setupDropZone(`dropZone_manual_${lang}`, `manual_audio_${lang}`, `fileName_manual_${lang}`, 'audio', () => updateGenerateButton());
    });

    // Setup Generate Button
    const generateBtn = document.getElementById('generateTranslatedVideoBtn');
    if (generateBtn) {
        generateBtn.addEventListener('click', () => window.startVideoTranslation());
    }

    // Setup Close/Cancel Button
    const cancelBtn = document.getElementById('cancelTranslateVideoBtn');
    if (cancelBtn) {
        cancelBtn.addEventListener('click', () => {
             if(confirm('¿Deseas cerrar esta página?')) {
                 window.close();
             }
        });
    }
});

// ==============================
// API KEYS MANAGEMENT (localStorage)
// ==============================
(function initApiKeysPanel() {
    const toggle = document.getElementById('keysToggleBtn');
    const panel = document.getElementById('keysPanel');
    const saveBtn = document.getElementById('keysSaveBtn');
    const status = document.getElementById('keysStatus');
    if (!toggle || !panel) return;

    const STORAGE_KEY = 'traductor_api_keys';

    // Toggle panel
    toggle.addEventListener('click', () => {
        const isOpen = panel.classList.toggle('open');
        toggle.classList.toggle('open', isOpen);
        if (isOpen) loadKeys();
    });

    // Show/hide key on focus/blur
    panel.querySelectorAll('.tv-key-input').forEach(input => {
        input.addEventListener('focus', () => { input.type = 'text'; });
        input.addEventListener('blur', () => { input.type = 'password'; });
    });

    function loadKeys() {
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
            panel.querySelectorAll('.tv-key-input').forEach(input => {
                const env = input.dataset.env;
                if (env && saved[env]) input.value = saved[env];
            });
        } catch (e) {
            console.error('Error loading keys from localStorage', e);
        }
    }

    saveBtn.addEventListener('click', () => {
        status.className = 'tv-keys-status';
        status.style.display = 'none';

        try {
            const inputs = panel.querySelectorAll('.tv-key-input');
            const keysObj = {};
            inputs.forEach(input => {
                const val = input.value.trim();
                if (val) keysObj[input.dataset.env] = val;
            });

            localStorage.setItem(STORAGE_KEY, JSON.stringify(keysObj));
            status.textContent = '✓ Keys guardadas en tu navegador';
            status.className = 'tv-keys-status success';
        } catch (e) {
            status.textContent = '✗ Error al guardar';
            status.className = 'tv-keys-status error';
        }
        setTimeout(() => { status.style.display = 'none'; status.className = 'tv-keys-status'; }, 3000);
    });

    // Load on init if panel starts open
    loadKeys();
})();

// Helper: get saved keys as object for sending with requests
window.getClientApiKeys = function() {
    try {
        return JSON.parse(localStorage.getItem('traductor_api_keys') || '{}');
    } catch (e) { return {}; }
};

window.switchTab = function(tabName) {
    // Remove active from all tab buttons
    document.querySelectorAll('.tv-tab-btn').forEach(btn => btn.classList.remove('active'));

    // Hide all tab contents
    document.getElementById('tabContentAuto').style.display = 'none';
    document.getElementById('tabContentManual').style.display = 'none';
    const costsTab = document.getElementById('tabContentCosts');
    if (costsTab) costsTab.style.display = 'none';

    // Activate selected tab
    const btnMap = { auto: 'tabBtnAuto', manual: 'tabBtnManual', costs: 'tabBtnCosts' };
    const btn = document.getElementById(btnMap[tabName]);
    if (btn) btn.classList.add('active');

    const contentMap = { auto: 'tabContentAuto', manual: 'tabContentManual', costs: 'tabContentCosts' };
    const content = document.getElementById(contentMap[tabName]);
    if (content) content.style.display = 'block';

    // Toggle sidebar settings visibility
    const autoSettings = document.getElementById('autoSettingsPanel');
    if (autoSettings) {
        autoSettings.style.display = tabName === 'auto' ? 'block' : 'none';
    }

    // Hide action bar on costs tab
    const actionBar = document.querySelector('.tv-action-bar');
    if (actionBar) actionBar.style.display = tabName === 'costs' ? 'none' : '';

    if (tabName === 'costs') loadCostDashboard();

    updateGenerateButtonText(tabName);
};

function updateGenerateButtonText(tabName) {
    const btn = document.getElementById('generateTranslatedVideoBtn');
    if (btn) {
        btn.innerHTML = tabName === 'auto' 
            ? '<i class="fas fa-magic"></i> Generar Audios de Traducción (IA)' 
            : '<i class="fas fa-hammer"></i> Procesar Videos Manualmente';
    }
}

window.toggleVoiceSelect = function() {
    const selectedProvider = document.querySelector('input[name="ttsProvider"]:checked')?.value;
    const googleContainer = document.getElementById('googleVoiceSelectContainer');
    const cloudContainer = document.getElementById('cloudVoiceSelectContainer');
    const groupSizeContainer = document.getElementById('groupSizeContainer');
    
    if (googleContainer) {
        googleContainer.style.display = (selectedProvider === 'google' || selectedProvider === 'google_pro') ? 'block' : 'none';
    }
    if (cloudContainer) {
        cloudContainer.style.display = (selectedProvider === 'google_cloud' || selectedProvider === 'google_wavenet') ? 'block' : 'none';
    }
    if (groupSizeContainer) {
        groupSizeContainer.style.display = (selectedProvider === 'text_only') ? 'none' : 'block';
    }
};

function setupDropZone(dropZoneId, inputId, displayId, allowedTypes, onFileSelect) {
    const dropZone = document.getElementById(dropZoneId);
    const input = document.getElementById(inputId);
    const display = document.getElementById(displayId);

    if (!dropZone || !input) return;

    dropZone.addEventListener('click', (e) => {
         if (e.target !== input) input.click();
    });

    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length) {
            input.files = e.dataTransfer.files;
            window.saveToDB('files', inputId, Array.from(input.files));
            validateAndHandle(input.files[0]);
        }
    });

    input.addEventListener('change', () => {
        if (input.files.length) {
            window.saveToDB('files', inputId, Array.from(input.files));
            validateAndHandle(input.files[0]);
        }
    });

    function validateAndHandle(file) {
        let valid = false;
        
        if (allowedTypes === 'video') {
            if (file.type === 'video/mp4' || file.name.toLowerCase().endsWith('.mp4')) valid = true;
            else alert('Por favor, selecciona un archivo .mp4 válido.');
        } else if (allowedTypes === 'audio') {
             if (file.type.startsWith('audio/') || file.name.toLowerCase().endsWith('.mp3') || file.name.toLowerCase().endsWith('.wav')) valid = true;
             else alert('Por favor, selecciona un archivo de audio válido (.mp3, .wav).');
        }

        if (valid) {
            if (display) display.textContent = file.name;
            if (onFileSelect) onFileSelect(file);
        } else {
            input.value = '';
            if (display) display.textContent = '';
        }
    }
}

function updateGenerateButton() {
    // Basic check, could be more robust
    const btn = document.getElementById('generateTranslatedVideoBtn');
    // For now we just enable it if interaction happened, validation happens on click
    if(btn) btn.disabled = false; 
}

window.startVideoTranslation = async function(isRetry = false) {      if (!isRetry) savePreferences(); // Save preferences on fresh start
    const isManualMode = document.getElementById('tabContentManual').style.display !== 'none';
    const generateBtn = document.getElementById('generateTranslatedVideoBtn');
    const retryBtn = document.getElementById('retryBtn');
    
    // UI Elements
    const progressContainer = document.getElementById('translateVideoProgress');
    const statusText = document.getElementById('translateVideoStatus');
    const progressBar = document.getElementById('translateVideoProgressBar');
    const percentText = document.getElementById('translateVideoPercent');
    const timeRemainingText = document.getElementById('translateVideoTimeRemaining');

    let file, musicFile;

    if (isManualMode) {
        const vIn = document.getElementById('videoUploadManual');
        const mIn = document.getElementById('musicUploadManual');
        file = vIn ? vIn.files[0] : null;
        musicFile = mIn && mIn.files.length ? mIn.files[0] : null;

        if (!file) {
            alert("Por favor selecciona un archivo de video para el modo manual.");
            return;
        }
    } else {
        const fileInput = document.getElementById('videoUpload');
        const musicInput = document.getElementById('musicUpload');
        file = fileInput ? fileInput.files[0] : null;
        musicFile = musicInput && musicInput.files.length ? musicInput.files[0] : null;

        if (!file && !isRetry) {
             alert("Por favor selecciona un archivo de video.");
             return;
        }

        // Check if video already exists on server
        if (file && !isRetry) {
            try {
                const checkRes = await fetch(`/api/check-video-exists?videoName=${file.name}`);
                const checkData = await checkRes.json();
                
                if (checkData.exists) {
                    const useExisting = confirm(`El video "${file.name}" ya existe en el servidor.\n¿Deseas usar la versión existente para ahorrar tiempo de subida?`);
                    if (useExisting) {
                        isRetry = true;
                    }
                }
            } catch (e) {
                console.warn('Could not check if video exists:', e);
            }
        }
    }

    // Start Process
    if (generateBtn) generateBtn.disabled = true;
    if (retryBtn) retryBtn.style.display = 'none';
    progressContainer.style.display = 'block';
    progressBar.style.background = '#6366f1';
    statusText.textContent = isRetry ? 'Reanudando proceso (usando archivo existente)...' : 'Iniciando subida...';
    progressBar.style.width = '0%';
    if (percentText) percentText.textContent = '0%';

    const formData = new FormData();
    const endScreenSeconds = parseInt(document.getElementById('endScreenSeconds')?.value) || 0;
    formData.append('endScreenSeconds', endScreenSeconds);

    let endpoint = '/api/translate-video';

    if (isManualMode) {
        endpoint = '/api/manual-translate-video';
        if (file) formData.append('video', file);
        if (musicFile) formData.append('music', musicFile);

        const langs = ['en', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ko', 'ja'];
        let audioCount = 0;
        langs.forEach(lang => {
            const el = document.getElementById('manual_audio_' + lang);
            if (el && el.files.length > 0) {
                formData.append('audio_' + lang, el.files[0]);
                audioCount++;
            }
        });

        if (audioCount === 0) {
            alert("Por favor selecciona al menos un archivo de audio para un idioma.");
            if (generateBtn) generateBtn.disabled = false;
            progressContainer.style.display = 'none';
            return;
        }
    } else {
        // Auto Mode logic
        if (isRetry) {
            formData.append('retryVideoName', file ? file.name : '');
        } else {
            formData.append('video', file);
        }
        if (musicFile) formData.append('music', musicFile);

        const ttsProvider = document.querySelector('input[name="ttsProvider"]:checked')?.value || 'google';
        formData.append('ttsProvider', ttsProvider);

        const selectedLanguages = Array.from(document.querySelectorAll('input[name="targetLanguages"]:checked'))
            .map(cb => cb.value);
        formData.append('targetLanguages', JSON.stringify(selectedLanguages));

        const googleVoice = document.getElementById('googleVoiceSelect')?.value || 'Kore';
        formData.append('googleVoice', googleVoice);

        const cloudVoice = document.getElementById('cloudVoiceSelect')?.value || 'male';
        formData.append('cloudVoice', cloudVoice);

        const gsIdx = parseInt(document.getElementById('groupSizeSlider')?.value ?? '1');
        const groupSize = [1, 3, 6, 9, 12][gsIdx] ?? 3;
        formData.append('groupSize', groupSize);

        const useRandomVoice = document.getElementById('randomVoiceCheckbox')?.checked || false;
        formData.append('randomVoice', useRandomVoice);

        const usePodcastStyle = document.getElementById('podcastStyleCheckbox')?.checked || false;
        formData.append('podcastStyle', usePodcastStyle);

        const keepTempFiles = document.getElementById('keepTempCheckbox')?.checked || false;
        formData.append('keepTempFiles', keepTempFiles);

        const translationModel = document.querySelector('input[name="translationModel"]:checked')?.value || 'gemini-3-flash-preview';
        formData.append('translationModel', translationModel);

        const transcriptionMethod = document.querySelector('input[name="transcriptionMethod"]:checked')?.value || 'gemini';
        formData.append('transcriptionMethod', transcriptionMethod);
    }

    // Append client API keys from localStorage
    const clientKeys = window.getClientApiKeys();
    if (Object.keys(clientKeys).length > 0) {
        formData.append('clientApiKeys', JSON.stringify(clientKeys));
    }

    const startTime = Date.now();

    try {
        const response = await fetch(endpoint, { method: 'POST', body: formData });
        if (!response.ok) throw new Error('Error en la solicitud');

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value);
            const lines = chunk.split('\n');
            
            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    try {
                        const data = JSON.parse(line.slice(6));
                        
                        if (data.status) statusText.textContent = data.status;
                        
                        if (data.progress) {
                            const p = parseFloat(data.progress);
                            progressBar.style.width = `${p}%`;
                            if (percentText) percentText.textContent = `${Math.round(p)}%`;
                            
                            // Time estimation
                            if (p > 0) {
                                const elapsed = Date.now() - startTime;
                                const total = (elapsed / p) * 100;
                                const remaining = Math.max(0, (total - elapsed) / 1000);
                                const m = Math.floor(remaining / 60);
                                const s = Math.floor(remaining % 60);
                                timeRemainingText.textContent = `Restante: ${m}:${s.toString().padStart(2, '0')}`;
                            }
                        }

                        // Handle cost summary from PRINCIPAL API
                        if (data.costSummary) {
                            window._lastCostSummary = data.costSummary;
                        }

                        if (data.completed) {
                            let completedMsg = '¡Completado!';
                            let alertMsg = 'Proceso completado correctamente. Revisa la carpeta "outputs".';

                            if (window._lastCostSummary && window._lastCostSummary.totalCost > 0) {
                                const cost = window._lastCostSummary;
                                const totalStr = cost.totalCost < 0.01
                                    ? '< $0.01'
                                    : `$${cost.totalCost.toFixed(4)}`;
                                completedMsg += ` | Costo API Principal: ${totalStr} USD`;

                                let details = `\n\nDesglose por modelo (API Principal):`;
                                for (const [model, info] of Object.entries(cost.byModel)) {
                                    const modelCost = info.cost < 0.01 ? '< $0.01' : `$${info.cost.toFixed(4)}`;
                                    if (info.characters > 0) {
                                        details += `\n  ${model}: ${modelCost} (${info.characters.toLocaleString()} caracteres)`;
                                    } else {
                                        details += `\n  ${model}: ${modelCost} (${info.input.toLocaleString()} in / ${info.output.toLocaleString()} out tokens)`;
                                    }
                                }
                                alertMsg += details;
                                window._lastCostSummary = null;
                            }

                            statusText.textContent = completedMsg;
                            progressBar.style.width = '100%';
                            if (retryBtn) retryBtn.style.display = 'none';
                            alert(alertMsg);
                            if (generateBtn) generateBtn.disabled = false;
                        }

                        if (data.error) throw new Error(data.error);

                    } catch (e) {
                        console.error("Parse error", e);
                    }
                }
            }
        }
    } catch (error) {
        console.error(error);
        statusText.textContent = 'Error: ' + error.message;
        progressBar.style.background = '#e53e3e';
        if (generateBtn) generateBtn.disabled = false;
        if (retryBtn) {
            retryBtn.style.display = 'block';
            retryBtn.onclick = () => window.startVideoTranslation(true);
        }
    }
};


// --- Preference Management System ---
function savePreferences() {
    try {
        const prefs = {
            targetLangs: Array.from(document.querySelectorAll('input[name="targetLanguages"]:checked')).map(el => el.value),
            translationModel: document.querySelector('input[name="translationModel"]:checked')?.value,
            ttsProvider: document.querySelector('input[name="ttsProvider"]:checked')?.value,
            googleVoice: document.getElementById('googleVoiceSelect')?.value,
            cloudVoice: document.getElementById('cloudVoiceSelect')?.value,
            groupSize: [1, 3, 6, 9, 12][parseInt(document.getElementById('groupSizeSlider')?.value ?? '1')] ?? 3,
            endScreenSeconds: parseInt(document.getElementById('endScreenSeconds')?.value) || 0
        };
        localStorage.setItem('videoTranslatorPrefs', JSON.stringify(prefs));
        console.log('Preferences saved:', prefs);
    } catch (e) {
        console.error('Error saving preferences:', e);
    }
}

function loadPreferences() {
    try {
        const prefs = JSON.parse(localStorage.getItem('videoTranslatorPrefs'));
        if (!prefs) return;

        // Restore Languages
        if (prefs.targetLangs && Array.isArray(prefs.targetLangs)) {
            // Uncheck all first
            document.querySelectorAll('input[name="targetLanguages"]').forEach(el => el.checked = false);
            // Check saved ones
            prefs.targetLangs.forEach(lang => {
                const el = document.querySelector(`input[name='targetLanguages'][value='${lang}']`);
                if (el) el.checked = true;
            });
        }

        // Restore Translation Model
        if (prefs.translationModel) {
            const radio = document.querySelector(`input[name='translationModel'][value='${prefs.translationModel}']`);
            if (radio) radio.checked = true;
        }

        // Restore TTS Provider
        if (prefs.ttsProvider) {
            const radio = document.querySelector(`input[name='ttsProvider'][value='${prefs.ttsProvider}']`);
            if (radio) {
                radio.checked = true;
                if (window.toggleVoiceSelect) window.toggleVoiceSelect();
            }
        }

        // Restore Cloud Voice
        if (prefs.cloudVoice) {
            const sel = document.getElementById('cloudVoiceSelect');
            if (sel) sel.value = prefs.cloudVoice;
        }

        // Restore Group Size
        if (prefs.groupSize) {
            const slider = document.getElementById('groupSizeSlider');
            const label = document.getElementById('groupSizeValue');
            const gsMap = [1, 3, 6, 9, 12];
            const idx = gsMap.indexOf(prefs.groupSize);
            if (slider && idx >= 0) { slider.value = idx; if (label) label.textContent = prefs.groupSize; }
        }

        // Restore End Screen Seconds
        if (prefs.endScreenSeconds !== undefined) {
            const el = document.getElementById('endScreenSeconds');
            if (el) el.value = prefs.endScreenSeconds;
        }

        // Restore Google Voice
        if (prefs.googleVoice) {
            const select = document.getElementById('googleVoiceSelect');
            if (select) select.value = prefs.googleVoice;
        }

        console.log('Preferences loaded:', prefs);
    } catch (e) {
        console.error('Error loading preferences', e);
    }
}

// ==============================
// COST DASHBOARD
// ==============================
let _costChart = null;
let _costShowMXN = false;
let _costData = null;
let _costMxnRate = 18;

async function loadCostDashboard() {
    try {
        const resp = await fetch('/api/costs');
        const json = await resp.json();
        _costData = json.costs || [];
        _costMxnRate = json.mxnRate || 18;
        renderCostDashboard();
    } catch (e) {
        console.error('Error loading costs:', e);
    }
}

function fmt$(val) {
    const v = _costShowMXN ? val * _costMxnRate : val;
    const sym = _costShowMXN ? 'MXN' : 'USD';
    if (v < 0.01 && v > 0) return `< $0.01 ${sym}`;
    return `$${v.toFixed(v >= 1 ? 2 : 4)} ${sym}`;
}

function renderCostDashboard() {
    const costs = _costData || [];

    // Summary cards
    const totalUSD = costs.reduce((s, c) => s + (c.totalUSD || 0), 0);
    document.getElementById('costTotalDisplay').textContent = fmt$(totalUSD);
    document.getElementById('costVideoCount').textContent = costs.length;

    // Average per day
    if (costs.length > 0) {
        const days = new Set(costs.map(c => {
            const d = new Date(c.date);
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }));
        const avgPerDay = totalUSD / days.size;
        document.getElementById('costAvgDay').textContent = fmt$(avgPerDay);
    } else {
        document.getElementById('costAvgDay').textContent = fmt$(0);
    }

    // Aggregate by day for chart (local time)
    const byDay = {};
    costs.forEach(c => {
        const d = new Date(c.date);
        const day = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        byDay[day] = (byDay[day] || 0) + (c.totalUSD || 0);
    });
    const sortedDays = Object.keys(byDay).sort();
    const dayLabels = sortedDays.map(d => { const [y, m, dd] = d.split('-'); return `${dd}/${m}`; });
    const dayValues = sortedDays.map(d => _costShowMXN ? byDay[d] * _costMxnRate : byDay[d]);

    // Chart
    const ctx = document.getElementById('costChart');
    if (_costChart) _costChart.destroy();
    _costChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: dayLabels,
            datasets: [{
                label: _costShowMXN ? 'Costo (MXN)' : 'Costo (USD)',
                data: dayValues,
                backgroundColor: 'rgba(167, 139, 250, 0.6)',
                borderColor: '#a78bfa',
                borderWidth: 1,
                borderRadius: 6,
                maxBarThickness: 50,
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    callbacks: {
                        label: (ctx) => {
                            const v = ctx.raw;
                            const sym = _costShowMXN ? 'MXN' : 'USD';
                            return ` $${v.toFixed(v >= 1 ? 2 : 4)} ${sym}`;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { color: '#71717a', callback: (v) => '$' + v.toFixed(2) },
                    grid: { color: 'rgba(63, 63, 70, 0.3)' }
                },
                x: {
                    ticks: { color: '#71717a' },
                    grid: { display: false }
                }
            }
        }
    });

    // Detail table
    const tbody = document.getElementById('costTableBody');
    if (costs.length === 0) {
        tbody.innerHTML = '<tr><td colspan="4" style="padding: 30px; text-align: center; color: #52525b;">Sin datos aún</td></tr>';
    } else {
        const reversed = [...costs].reverse();
        tbody.innerHTML = reversed.map(c => {
            const d = new Date(c.date);
            const dateStr = d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
            const timeStr = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
            const langs = (c.languages || []).join(', ').toUpperCase() || '-';
            return `<tr style="border-bottom: 1px solid #1f1f23;">
                <td style="padding: 10px 14px; color: #a1a1aa;">${dateStr} <span style="color:#52525b;">${timeStr}</span></td>
                <td style="padding: 10px 14px; color: #e2e8f0; max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${c.video || '-'}</td>
                <td style="padding: 10px 14px; color: #71717a; font-size: 0.8em;">${langs}</td>
                <td style="padding: 10px 14px; color: #a78bfa; font-weight: 700; text-align: right;">${fmt$(c.totalUSD || 0)}</td>
            </tr>`;
        }).join('');
    }

    // Model breakdown
    const allModels = {};
    costs.forEach(c => {
        if (!c.byModel) return;
        for (const [model, info] of Object.entries(c.byModel)) {
            if (!allModels[model]) allModels[model] = { cost: 0, input: 0, output: 0, characters: 0 };
            allModels[model].cost += info.cost || 0;
            allModels[model].input += info.input || 0;
            allModels[model].output += info.output || 0;
            allModels[model].characters += info.characters || 0;
        }
    });

    const modelDiv = document.getElementById('costModelBreakdown');
    const modelEntries = Object.entries(allModels).sort((a, b) => b[1].cost - a[1].cost);
    if (modelEntries.length === 0) {
        modelDiv.innerHTML = '<span style="color: #52525b;">Sin datos</span>';
    } else {
        modelDiv.innerHTML = modelEntries.map(([model, info]) => {
            const pct = totalUSD > 0 ? ((info.cost / totalUSD) * 100).toFixed(1) : '0.0';
            const detail = info.characters > 0
                ? `${info.characters.toLocaleString()} chars`
                : `${info.input.toLocaleString()} in / ${info.output.toLocaleString()} out tokens`;
            return `<div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid #1f1f23;">
                <div>
                    <span style="color: #e2e8f0; font-weight: 600;">${model}</span>
                    <span style="color: #52525b; font-size: 0.8em; margin-left: 8px;">${detail}</span>
                </div>
                <div style="text-align: right;">
                    <span style="color: #a78bfa; font-weight: 700;">${fmt$(info.cost)}</span>
                    <span style="color: #52525b; font-size: 0.8em; margin-left: 6px;">(${pct}%)</span>
                </div>
            </div>`;
        }).join('');
    }
}

window.toggleCostCurrency = function() {
    _costShowMXN = !_costShowMXN;
    document.getElementById('currencyLabel').textContent = _costShowMXN ? 'MXN' : 'USD';
    renderCostDashboard();
};

window.clearCostHistory = async function() {
    if (!confirm('¿Borrar todo el historial de costos? Esta acción no se puede deshacer.')) return;
    try {
        await fetch('/api/costs', { method: 'DELETE' });
        _costData = [];
        renderCostDashboard();
    } catch (e) {
        alert('Error al borrar: ' + e.message);
    }
};

// ==============================
// OUTPUT DIRECTORY CONFIG
// ==============================
async function loadOutputDir() {
    try {
        const input = document.getElementById('outputDirInput');
        // Show cached value immediately while fetching
        const cached = localStorage.getItem('lastOutputDir');
        if (input && cached) input.value = cached;
        
        const resp = await fetch('/api/settings/output-dir');
        const data = await resp.json();
        if (input && data.outputsDir) {
            input.value = data.outputsDir;
            localStorage.setItem('lastOutputDir', data.outputsDir);
        }
    } catch (e) {}
}

window.changeOutputDir = async function() {
    try {
        const btn = document.querySelector('[onclick="changeOutputDir()"]');
        if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i>'; }
        const resp = await fetch('/api/settings/pick-output-dir', { method: 'POST' });
        const data = await resp.json();
        if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fas fa-pen"></i>'; }
        if (data.success) {
            document.getElementById('outputDirInput').value = data.outputsDir;
            localStorage.setItem('lastOutputDir', data.outputsDir);
        }
    } catch (e) {
        alert('Error: ' + e.message);
    }
};

