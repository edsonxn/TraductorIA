import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import fs from 'fs';
import { spawn, spawnSync } from 'child_process';
import { promisify } from 'util';
import { writeFile } from 'fs/promises';
import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import multer from 'multer';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { GoogleGenAI } from '@google/genai';
import textToSpeech from '@google-cloud/text-to-speech';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Load .env from app directory (works in both dev and packaged Electron)
dotenv.config({ path: path.join(__dirname, '.env') });

// ==============================
// CONFIGURACIÓN
// ==============================

const FIREBASE_API_KEY = process.env.FIREBASE_API_KEY || 'AIzaSyA_A2Sfb9ulOsVEwA5C4H9_QX3yNZQlpug';
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || 'traductor-video-ia';

const GEMINI_TEXT_MODEL = process.env.GEMINI_TEXT_MODEL || 'gemini-3.1-pro-preview';
const GEMINI_TTS_MODEL_FLASH = process.env.GEMINI_TTS_MODEL_FLASH || 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_MODEL_PRO = process.env.GEMINI_TTS_MODEL_PRO || 'gemini-2.5-pro-preview-tts';

// Precios por 1M tokens (USD) — Paid Tier Standard, prompts <= 200k
const API_PRICING = {
    'gemini-3.1-pro-preview':        { input: 2.00,  output: 12.00 },
    'gemini-3-flash-preview':        { input: 0.50,  output: 3.00 },
    'gemini-3.1-flash-lite-preview': { input: 0.25,  output: 1.50 },
    'gemini-2.5-flash':              { input: 0.30,  output: 2.50, audioInput: 1.00 },
    'gemini-2.5-flash-preview-tts':  { input: 0.50,  output: 10.00 },
    'gemini-2.5-pro-preview-tts':    { input: 1.00,  output: 20.00 },
    'cloud-tts-neural2':             { perMillionChars: 16.00 },
    'cloud-tts-wavenet':             { perMillionChars: 4.00 },
};

function createCostTracker() {
    return { entries: [] };
}

function trackCost(tracker, modelName, inputTokens, outputTokens, type = 'text') {
    if (!tracker || !inputTokens && !outputTokens) return;
    tracker.entries.push({ model: modelName, inputTokens: inputTokens || 0, outputTokens: outputTokens || 0, type });
}

function trackCloudTTSCost(tracker, modelName, characters) {
    if (!tracker || !characters) return;
    tracker.entries.push({ model: modelName, characters, type: 'cloud-tts' });
}

function calculateCostSummary(tracker) {
    if (!tracker || !tracker.entries.length) return null;
    let totalCost = 0;
    const byModel = {};

    for (const e of tracker.entries) {
        const pricing = API_PRICING[e.model];
        if (!pricing) continue;

        let cost = 0;
        if (e.type === 'cloud-tts' && pricing.perMillionChars) {
            cost = (e.characters / 1_000_000) * pricing.perMillionChars;
            if (!byModel[e.model]) byModel[e.model] = { input: 0, output: 0, characters: 0, cost: 0 };
            byModel[e.model].characters += e.characters;
        } else {
            const inputPrice = (e.type === 'audio' && pricing.audioInput) ? pricing.audioInput : pricing.input;
            cost = (e.inputTokens / 1_000_000) * inputPrice + (e.outputTokens / 1_000_000) * pricing.output;
            if (!byModel[e.model]) byModel[e.model] = { input: 0, output: 0, characters: 0, cost: 0 };
            byModel[e.model].input += e.inputTokens;
            byModel[e.model].output += e.outputTokens;
        }

        totalCost += cost;
        byModel[e.model].cost += cost;
    }

    return { totalCost, byModel };
}

// ==============================
// PERSISTENT COST STORAGE
// ==============================
const COSTS_FILE = path.join(__dirname, 'costs.json');
const MXN_RATE = 18;

function loadCosts() {
    try {
        if (fs.existsSync(COSTS_FILE)) return JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
    } catch (e) { console.warn('⚠️ costs.json corrupto, reiniciando:', e.message); }
    return [];
}

function saveCostEntry(videoName, costSummary, languages) {
    if (!costSummary || costSummary.totalCost <= 0) return;
    const costs = loadCosts();
    costs.push({
        date: new Date().toISOString(),
        video: videoName,
        languages: languages || [],
        totalUSD: costSummary.totalCost,
        totalMXN: costSummary.totalCost * MXN_RATE,
        byModel: costSummary.byModel
    });
    try { fs.writeFileSync(COSTS_FILE, JSON.stringify(costs, null, 2), 'utf8'); }
    catch (e) { console.warn('⚠️ No se pudo guardar costs.json:', e.message); }
}

const app = express();
const PORT = process.env.PORT || 3001;

const GOOGLE_PRIMARY_API_NAME = 'PRINCIPAL';

// ==============================
// MANEJO DE API KEYS
// ==============================

const googleServiceUsageState = {
    llm: { preferPrimary: false, consecutivePrimaryFailures: 0, lastFailureReason: null, lastFailureTimestamp: null },
    tts: { preferPrimary: false, consecutivePrimaryFailures: 0, lastFailureReason: null, lastFailureTimestamp: null }
};

function getTrackedUsageState(context) {
    return googleServiceUsageState[context] || null;
}

function getFreeGoogleAPIKeys(clientKeys) {
    if (!clientKeys) return [];
    return [
        { key: clientKeys['GOOGLE_API_KEY_GRATIS'], name: 'GRATIS' },
        { key: clientKeys['GOOGLE_API_KEY_GRATIS2'], name: 'GRATIS2' },
        { key: clientKeys['GOOGLE_API_KEY_GRATIS3'], name: 'GRATIS3' },
        { key: clientKeys['GOOGLE_API_KEY_GRATIS4'], name: 'GRATIS4' },
        { key: clientKeys['GOOGLE_API_KEY_GRATIS5'], name: 'GRATIS5' }
    ].filter(apiKey => apiKey.key);
}

function getPrimaryGoogleAPIKey(clientKeys) {
    return (clientKeys && clientKeys['GOOGLE_API_KEY']) || null;
}

async function getGoogleAI(model = GEMINI_TEXT_MODEL, options = {}) {
    const { context = 'general', forcePrimary = false, clientKeys = null } = options;
    const usageState = getTrackedUsageState(context);
    const skipFreeApis = forcePrimary || usageState?.preferPrimary;

    const freeApiEntries = skipFreeApis ? [] : getFreeGoogleAPIKeys(clientKeys);
    const primaryKey = getPrimaryGoogleAPIKey(clientKeys);
    const primaryApiEntry = primaryKey
        ? { key: primaryKey, name: GOOGLE_PRIMARY_API_NAME }
        : null;

    if (!freeApiEntries.length && !primaryApiEntry) {
        throw new Error('No hay API keys configuradas. Agrega tus Google API Keys en el panel de la interfaz.');
    }

    let lastError = null;

    const attemptWithEntry = async (entry, keyType) => {
        if (!entry?.key) return null;
        const isPrimary = keyType === 'primary';
        const emoji = isPrimary ? '💰' : '🆓';
        const apiName = entry.name || (isPrimary ? GOOGLE_PRIMARY_API_NAME : 'API gratuita');

        console.log(`${emoji} Intentando con API ${apiName} (${context})...`);
        const genAI = new GoogleGenerativeAI(entry.key);
        const aiModel = genAI.getGenerativeModel({ model });
        await aiModel.countTokens("test");
        console.log(`✅ API ${apiName} lista para usarse (${context})`);
        return { genAI, model: aiModel, apiKeyName: apiName, keyType };
    };

    if (freeApiEntries.length) {
        for (const entry of freeApiEntries) {
            try {
                const result = await attemptWithEntry(entry, 'free');
                if (result) return result;
            } catch (error) {
                lastError = error;
                console.warn(`⚠️ API ${entry.name} falló: ${error.message}`);
            }
        }
    }

    if (!primaryApiEntry) {
        throw new Error(`Las APIs gratuitas fallaron y no hay API principal disponible. Último error: ${lastError?.message || 'desconocido'}`);
    }

    try {
        return await attemptWithEntry(primaryApiEntry, 'primary');
    } catch (error) {
        throw error;
    }
}

// Cache de clientes Google GenAI TTS
const googleTTSClients = new Map();

function getGoogleTTSClient(apiKey) {
    if (!apiKey) throw new Error('No hay API key de Google configurada para TTS');
    if (!googleTTSClients.has(apiKey)) {
        googleTTSClients.set(apiKey, new GoogleGenAI({ apiKey }));
    }
    return googleTTSClients.get(apiKey);
}

// ==============================
// DIRECTORIO DE OUTPUTS
// ==============================

let globalOutputDir = process.env.OUTPUTS_DIR || path.join(process.cwd(), 'outputs');
const settingsPath = path.join(process.cwd(), 'settings.json');

try {
    if (fs.existsSync(settingsPath)) {
        const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        if (settings.outputsDir) globalOutputDir = settings.outputsDir;
    }
} catch (e) {
    console.error("Error cargando settings.json:", e);
}

try {
    if (!fs.existsSync(globalOutputDir)) {
        fs.mkdirSync(globalOutputDir, { recursive: true });
    }
} catch (e) {
    console.warn(`⚠️ No se pudo crear outputsDir "${globalOutputDir}", usando default.`);
    globalOutputDir = path.join(process.cwd(), 'outputs');
    if (!fs.existsSync(globalOutputDir)) fs.mkdirSync(globalOutputDir, { recursive: true });
}

// ==============================
// MIDDLEWARE
// ==============================

app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ limit: '50mb', extended: true }));
app.use('/outputs', express.static(globalOutputDir));
app.use(express.static('public'));

// Multer config
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        const tempDir = './temp';
        if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
        cb(null, tempDir);
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '_' + file.originalname);
    }
});

const upload = multer({
    storage: storage,
    limits: {
        fileSize: 50 * 1024 * 1024 * 1024,
        fieldSize: 100 * 1024 * 1024
    },
    fileFilter: function (req, file, cb) {
        const allowedExtensions = ['.mp3', '.wav', '.m4a', '.mp4', '.txt'];
        const isValid = allowedExtensions.some(ext => file.originalname.toLowerCase().endsWith(ext));
        if (isValid) cb(null, true);
        else cb(new Error('Formato de archivo no soportado'));
    }
});

// ==============================
// FUNCIONES AUXILIARES
// ==============================

async function saveWaveFile(filename, pcmData, channels = 1, rate = 24000, sampleWidth = 2) {
    const dataLength = pcmData.length;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM format
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(rate, 24);
    header.writeUInt32LE(rate * channels * sampleWidth, 28);
    header.writeUInt16LE(channels * sampleWidth, 32);
    header.writeUInt16LE(sampleWidth * 8, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataLength, 40);
    const wavBuffer = Buffer.concat([header, pcmData]);
    await writeFile(filename, wavBuffer);
}

// ==============================
// GEMINI TRANSCRIPTION (replaces Whisper)
// ==============================

const GEMINI_TRANSCRIPTION_MODEL = 'gemini-3.1-pro-preview';

// ==============================
// WHISPER LOCAL TRANSCRIPTION
// ==============================

function findPythonCommand() {
    const candidates = process.platform === 'win32' ? ['py', 'python', 'python3'] : ['python3', 'python'];
    for (const cmd of candidates) {
        try {
            const result = spawnSync(cmd, ['--version'], { timeout: 5000, stdio: 'pipe', shell: true, windowsHide: true });
            const output = (result.stdout || '').toString() + (result.stderr || '').toString();
            if (result.status === 0 && output.includes('Python')) {
                console.log(`🐍 Usando: ${cmd}`);
                return cmd;
            }
        } catch (_) {}
    }
    console.error('❌ No se encontró Python. Instala Python y agrega al PATH.');
    return 'python';
}

let _pythonCmd = null;
function getPython() {
    if (!_pythonCmd) _pythonCmd = findPythonCommand();
    return _pythonCmd;
}

async function transcribeWithWhisperLocal(audioPath, language = null, modelSize = 'large-v3') {
    return new Promise((resolve, reject) => {
        const args = [path.join(__dirname, 'whisper_local.py'), 'transcribe', audioPath, language || 'auto', modelSize];
        const pythonCmd = getPython();
        console.log(`🎙️ Transcribiendo con Whisper Local (${modelSize}) usando ${pythonCmd}...`);
        
        const proc = spawn(pythonCmd, args, { cwd: __dirname, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, shell: true, windowsHide: true });
        let stdout = '';
        let stderr = '';
        
        proc.stdout.on('data', d => stdout += d);
        proc.stderr.on('data', d => stderr += d);
        
        proc.on('close', code => {
            if (code !== 0) {
                // Python errors go to stdout as JSON, check there first
                let errorMsg = stderr.slice(-500);
                try {
                    const errResult = JSON.parse(stdout);
                    if (errResult.error) errorMsg = errResult.error;
                } catch (_) {
                    if (stdout.trim()) errorMsg = errorMsg || stdout.slice(-500);
                }
                console.error(`❌ Whisper Local error: ${errorMsg}`);
                return reject(new Error(`Whisper Local failed (code ${code}): ${errorMsg}`));
            }
            try {
                const result = JSON.parse(stdout);
                if (!result.success) {
                    return reject(new Error(result.error || 'Whisper transcription failed'));
                }
                // Normalize to same format as Gemini transcription
                const normalized = {
                    language: result.language,
                    transcript: result.transcript,
                    segments: (result.segments || []).map(s => ({
                        start: Math.round(s.start * 100) / 100,
                        end: Math.round(s.end * 100) / 100,
                        text: s.text
                    }))
                };
                console.log(`✅ Whisper Local: ${normalized.segments.length} segmentos, idioma: ${normalized.language}`);
                resolve(normalized);
            } catch (e) {
                reject(new Error(`Failed to parse Whisper output: ${e.message}`));
            }
        });
        
        proc.on('error', err => {
            reject(new Error(`Could not start Python: ${err.message}`));
        });
    });
}

async function transcribeAudioWithGemini(audioPath, clientKeys = null) {
    const freeKeys = getFreeGoogleAPIKeys(clientKeys);
    const primaryKey = getPrimaryGoogleAPIKey(clientKeys);
    
    const keysToTry = [...freeKeys];
    if (primaryKey) keysToTry.push({ key: primaryKey, name: GOOGLE_PRIMARY_API_NAME, isPrimary: true });
    if (keysToTry.length === 0) throw new Error('No hay API keys configuradas para transcripción.');

    const audioBuffer = fs.readFileSync(audioPath);
    const base64Audio = audioBuffer.toString('base64');
    const ext = path.extname(audioPath).toLowerCase();
    const mimeType = ext === '.wav' ? 'audio/wav' : ext === '.m4a' ? 'audio/m4a' : 'audio/mpeg';

    const prompt = `Transcribe this audio accurately. Return ONLY a valid JSON object with this exact structure, no markdown, no code blocks:
{"language": "es", "transcript": "the full transcription text here", "segments": [{"start": 0.0, "end": 2.5, "text": "segment text"}]}

Rules:
- "language" must be the ISO 639-1 code of the detected spoken language (e.g. "es", "en", "fr", "de", "pt", "it", "ru", "zh", "ko", "ja")
- "transcript" must contain the complete transcription as a single string
- "segments" is an array where each segment has "start" (seconds), "end" (seconds), and "text"
- Each segment should contain ONE sentence or short phrase only
- CRITICAL: Keep each segment UNDER 15 seconds. If a sentence is long, split it at natural pauses
- Timestamps must be precise and in seconds (decimal). Do NOT lose accuracy after the first minute
- Pay special attention to timestamp accuracy for audio beyond 60 seconds
- Preserve the original language of the audio
- Return ONLY the JSON object, nothing else`;

    let lastError = null;
    for (const entry of keysToTry) {
        for (let attempt = 0; attempt < 2; attempt++) {
        try {
            console.log(`🎙️ Transcribiendo con API ${entry.name} (${GEMINI_TRANSCRIPTION_MODEL})... intento ${attempt + 1}`);
            const client = new GoogleGenAI({ apiKey: entry.key });

            const response = await client.models.generateContent({
                model: GEMINI_TRANSCRIPTION_MODEL,
                contents: [{
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType, data: base64Audio } },
                        { text: prompt }
                    ]
                }]
            });

            let responseText = response?.candidates?.[0]?.content?.parts?.[0]?.text || '';
            // Clean markdown code blocks if present
            responseText = responseText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

            let result;
            try {
                result = JSON.parse(responseText);
            } catch (parseErr) {
                // Try to fix common JSON issues from Gemini:
                // 1. Unescaped quotes inside string values
                // 2. Trailing commas
                // 3. Control characters
                let cleaned = responseText
                    .replace(/[\x00-\x1F\x7F]/g, ' ') // Remove control chars
                    .replace(/,\s*([}\]])/g, '$1');      // Remove trailing commas

                // Try to fix unescaped quotes inside strings by re-building
                try {
                    result = JSON.parse(cleaned);
                } catch (e2) {
                    // Last resort: extract transcript and segments manually
                    console.warn('⚠️ JSON parse failed, attempting manual extraction...');
                    const transcriptMatch = cleaned.match(/"transcript"\s*:\s*"([\s\S]*?)(?:"\s*,\s*"segments"|"\s*})/);
                    const transcript = transcriptMatch ? transcriptMatch[1].replace(/(?<!\\)"/g, '\\"') : null;
                    if (!transcript) throw new Error(`JSON parse failed: ${parseErr.message}`);

                    // Extract segments array
                    const segMatch = cleaned.match(/"segments"\s*:\s*(\[[\s\S]*\])\s*\}?\s*$/);
                    let segments = [];
                    if (segMatch) {
                        try {
                            // Fix unescaped quotes in segment texts
                            let segJson = segMatch[1].replace(/"text"\s*:\s*"([\s\S]*?)"\s*}/g, (match, txt) => {
                                return `"text": "${txt.replace(/(?<!\\)"/g, '\\"')}"}`;
                            });
                            segments = JSON.parse(segJson);
                        } catch (e3) {
                            console.warn('⚠️ Could not parse segments, continuing with transcript only');
                        }
                    }
                    result = { transcript, segments };
                }
            }
            if (!result.transcript) throw new Error('Respuesta sin transcript');

            // Validate segments exist — retry if empty
            if (!result.segments || result.segments.length === 0) {
                console.warn(`⚠️ Transcripción sin segmentos (intento ${attempt + 1}), reintentando...`);
                if (attempt < 1) continue; // retry same key
                // Last resort: generate segments from transcript using a second call
                console.log('🔄 Generando segmentos con segunda llamada...');
                try {
                    const segResponse = await client.models.generateContent({
                        model: GEMINI_TRANSCRIPTION_MODEL,
                        contents: [{
                            role: 'user',
                            parts: [
                                { inlineData: { mimeType, data: base64Audio } },
                                { text: `I have this transcript of the audio. Now I need ONLY the timestamps for each sentence/phrase.

TRANSCRIPT:
${result.transcript}

Return ONLY a JSON array of segments. Each segment must have "start" (seconds), "end" (seconds), and "text" fields.
Keep each segment under 15 seconds. Split long sentences at natural pauses.
Be precise with timestamps. Return ONLY the JSON array, nothing else.
Example: [{"start": 0.0, "end": 2.5, "text": "Hello world"}]` }
                            ]
                        }]
                    });
                    let segText = segResponse?.candidates?.[0]?.content?.parts?.[0]?.text || '';
                    segText = segText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
                    const parsedSegs = JSON.parse(segText);
                    if (Array.isArray(parsedSegs) && parsedSegs.length > 0) {
                        result.segments = parsedSegs;
                        console.log(`✅ Segmentos recuperados: ${parsedSegs.length}`);
                    }
                } catch (segErr) {
                    console.warn('⚠️ No se pudieron generar segmentos en segunda llamada:', segErr.message);
                }
            }
            
            console.log(`✅ Transcripción completada con API ${entry.name} (${result.segments?.length || 0} segmentos)`);
            return result;
        } catch (error) {
            lastError = error;
            console.warn(`⚠️ Transcripción falló con API ${entry.name}: ${error.message}`);
        }
        } // end attempt loop
    }
    throw new Error(`Transcripción falló con todas las API keys: ${lastError?.message || 'error desconocido'}`);
}

/**
 * Split oversized segments into smaller ones based on sentence boundaries.
 * If a segment is longer than maxDuration, split its text by sentences and
 * distribute the duration proportionally by character count.
 */
function splitOversizedSegments(segments, maxDuration = 18) {
    const result = [];
    for (const seg of segments) {
        const dur = seg.end - seg.start;
        if (dur <= maxDuration || !seg.text) {
            result.push(seg);
            continue;
        }

        // Split by sentence boundaries
        const sentences = seg.text.match(/[^.!?]+[.!?]+[\s]*/g);
        if (!sentences || sentences.length <= 1) {
            // Can't split further, try splitting by commas for very long text
            const parts = seg.text.split(/,\s*/);
            if (parts.length <= 1) {
                result.push(seg);
                continue;
            }
            const totalChars = parts.reduce((s, p) => s + p.length, 0);
            let currentStart = seg.start;
            for (let i = 0; i < parts.length; i++) {
                const ratio = parts[i].length / totalChars;
                const partDur = dur * ratio;
                const partEnd = (i === parts.length - 1) ? seg.end : currentStart + partDur;
                result.push({
                    start: Math.round(currentStart * 100) / 100,
                    end: Math.round(partEnd * 100) / 100,
                    text: parts[i].trim() + (i < parts.length - 1 ? ',' : '')
                });
                currentStart = partEnd;
            }
            continue;
        }

        const totalChars = sentences.reduce((s, sent) => s + sent.length, 0);
        let currentStart = seg.start;
        for (let i = 0; i < sentences.length; i++) {
            const ratio = sentences[i].length / totalChars;
            const sentDur = dur * ratio;
            const sentEnd = (i === sentences.length - 1) ? seg.end : currentStart + sentDur;
            result.push({
                start: Math.round(currentStart * 100) / 100,
                end: Math.round(sentEnd * 100) / 100,
                text: sentences[i].trim()
            });
            currentStart = sentEnd;
        }
    }
    console.log(`📊 Segmentos: ${segments.length} → ${result.length} (split de segmentos > ${maxDuration}s)`);
    return result;
}

/**
 * Fix timestamp issues from Gemini transcription:
 * 1. Clock resets: Gemini resets timestamps after crossing minute boundaries
 * 2. Compressed timestamps: After resets, segments often have durations of 0.03s
 *    for sentences that should last 3-5 seconds
 * 3. Large gaps: Anomalous jumps forward
 * 4. Inflated segments: Duration is wildly longer than what the text warrants
 *    (e.g. 45s assigned to a 5s sentence), causing silence gaps and desync
 * 
 * Strategy: Detect bad zones and rebuild timestamps using text-based estimation.
 * Use the speaking rate from the good segments as reference.
 */
function fixTimestampJumps(segments) {
    if (!segments || segments.length < 2) return segments;

    // First, calculate average speaking rate from segments that look "good"
    // (positive duration > 1s and reasonable chars/sec ratio)
    let totalGoodChars = 0;
    let totalGoodDuration = 0;
    for (const seg of segments) {
        const dur = seg.end - seg.start;
        if (dur >= 1.0 && seg.text) {
            const cps = seg.text.length / dur;
            if (cps > 5 && cps < 30) { // Reasonable range: 5-30 chars/sec
                totalGoodChars += seg.text.length;
                totalGoodDuration += dur;
            }
        }
    }
    const avgCharsPerSec = totalGoodDuration > 0 ? totalGoodChars / totalGoodDuration : 14;
    console.log(`📊 Speaking rate from good segments: ${avgCharsPerSec.toFixed(1)} chars/sec`);

    // Fix inflated segments: duration >> expected for text length
    // This catches cases like a 5s sentence assigned 45s (Gemini bug with end timestamp)
    let cumulativeShift = 0;
    for (let i = 0; i < segments.length; i++) {
        // Apply accumulated shift from previous fixes
        segments[i].start = Math.round((segments[i].start - cumulativeShift) * 100) / 100;
        segments[i].end = Math.round((segments[i].end - cumulativeShift) * 100) / 100;

        const dur = segments[i].end - segments[i].start;
        const textLen = (segments[i].text || '').length;
        if (textLen > 0 && dur > 10) {
            const expectedDur = textLen / avgCharsPerSec;
            // If actual duration is more than 3x the expected AND the excess is > 10s, it's inflated
            if (dur > expectedDur * 3 && (dur - expectedDur) > 10) {
                const newEnd = Math.round((segments[i].start + expectedDur + 0.5) * 100) / 100;
                const excess = segments[i].end - newEnd;
                console.warn(`⚠️ Inflated segment ${i}: ${dur.toFixed(1)}s for "${segments[i].text.substring(0, 50)}..." (expected ~${expectedDur.toFixed(1)}s). Trimming ${excess.toFixed(1)}s`);
                segments[i].end = newEnd;
                cumulativeShift += excess;
            }
        }
    }
    if (cumulativeShift > 0) {
        console.log(`📊 Total timestamp shift from inflated segments: ${cumulativeShift.toFixed(1)}s`);
    }

    // Walk through and detect bad zones
    const fixed = [{ ...segments[0] }];
    if (fixed[0].end <= fixed[0].start) {
        fixed[0].end = fixed[0].start + Math.max(2, fixed[0].text.length / avgCharsPerSec);
    }

    for (let i = 1; i < segments.length; i++) {
        const prev = fixed[i - 1];
        const curr = { ...segments[i] };
        const rawDur = curr.end - curr.start;
        const textLen = (curr.text || '').length;

        // Detect clock reset or backward jump
        const isClockReset = curr.start < prev.end - 5;
        // Detect compressed timestamp (very short duration for substantial text)
        const isCompressed = rawDur < 0.5 && textLen > 15;
        // Detect negative duration
        const isNegative = rawDur <= 0;

        if (isClockReset || isCompressed || isNegative) {
            // Estimate this segment's duration from text
            const estimatedDur = Math.max(1.5, textLen / avgCharsPerSec);
            // Place right after previous segment with a small gap
            const normalGap = 0.4;
            curr.start = Math.round((prev.end + normalGap) * 100) / 100;
            curr.end = Math.round((curr.start + estimatedDur) * 100) / 100;

            if (isClockReset) {
                console.warn(`⚠️ Clock reset at segment ${i} (was ${segments[i].start}→${segments[i].end}). Rebuilt: ${curr.start}→${curr.end}`);
            } else {
                console.warn(`⚠️ Bad timestamp at segment ${i}: ${rawDur.toFixed(2)}s for ${textLen} chars. Rebuilt: ${curr.start}→${curr.end} (${estimatedDur.toFixed(1)}s)`);
            }
        } else {
            // Segment looks OK, but check if there's a huge gap
            const gap = curr.start - prev.end;
            if (gap > 8) {
                const shift = gap - 0.5;
                curr.start = Math.round((curr.start - shift) * 100) / 100;
                curr.end = Math.round((curr.end - shift) * 100) / 100;
                console.warn(`⚠️ Large gap (${gap.toFixed(2)}s) reduced at segment ${i}`);
            } else if (gap < -0.1) {
                // Overlap: push forward
                curr.start = prev.end;
                const dur = segments[i].end - segments[i].start;
                curr.end = Math.round((curr.start + Math.max(1.0, dur)) * 100) / 100;
            }
        }

        fixed.push(curr);
    }

    console.log(`📊 Timestamps: original last=${segments[segments.length-1].end.toFixed(1)}s → fixed last=${fixed[fixed.length-1].end.toFixed(1)}s`);
    return fixed;
}


// ==============================
// GOOGLE TTS FUNCTIONS
// ==============================

async function generateSingleGoogleTTS(text, outputPath, lang, selectedVoice = 'Kore', modelName = GEMINI_TTS_MODEL_FLASH, clientKeys = null) {
    if (!text || !text.trim()) throw new Error("Text is empty");
    
    const voiceName = selectedVoice || 'Kore';
    const usageState = getTrackedUsageState('tts');
    const skipFreeApis = usageState?.preferPrimary;
    
    let keysToTry = [];
    if (!skipFreeApis) {
        const freeApiEntries = getFreeGoogleAPIKeys(clientKeys);
        for (let i = freeApiEntries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [freeApiEntries[i], freeApiEntries[j]] = [freeApiEntries[j], freeApiEntries[i]];
        }
        keysToTry = [...freeApiEntries];
    }
    const primaryKey = getPrimaryGoogleAPIKey(clientKeys);
    if (primaryKey) {
        keysToTry.push({ key: primaryKey, name: GOOGLE_PRIMARY_API_NAME, isPrimary: true });
    }
    if (keysToTry.length === 0) throw new Error('No hay API keys configuradas. Agrega tus Google API Keys en el panel de la interfaz.');

    let lastError = null;
    for (const entry of keysToTry) {
        let keyRetries = 1;
        while (keyRetries >= 0) {
            try {
                const client = getGoogleTTSClient(entry.key);
                console.log(`🔊 Generating Google TTS for ${lang} using ${entry.name} with model ${modelName}...`);

                const response = await client.models.generateContent({
                    model: modelName,
                    contents: [{ role: 'user', parts: [{ text: text }] }],
                    config: {
                        temperature: 0.5,
                        responseModalities: ['AUDIO'],
                        speechConfig: {
                            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceName } }
                        }
                    }
                });

                const audioPart = response?.candidates?.[0]?.content?.parts?.find(part => part.inlineData?.data);
                if (!audioPart?.inlineData?.data) throw new Error('Google TTS response missing audio data');

                const audioBuffer = Buffer.from(audioPart.inlineData.data, 'base64');
                if (audioBuffer.length < 100) throw new Error('Generated audio is too short/empty');

                const mimeType = audioPart.inlineData.mimeType || '';
                if (mimeType.includes('pcm') || !mimeType.includes('wav')) {
                    const rateMatch = mimeType.match(/rate=(\d+)/i);
                    const sampleRate = rateMatch ? parseInt(rateMatch[1], 10) : 24000;
                    await saveWaveFile(outputPath, audioBuffer, 1, sampleRate);
                } else {
                    await writeFile(outputPath, audioBuffer);
                }
                return {
                    isPrimary: entry.isPrimary || false,
                    model: modelName,
                    usage: response?.usageMetadata || null
                };

            } catch (error) {
                lastError = error;
                const isRateLimit = error.message.includes('429') || (error.status === 429) || error.message.includes('RESOURCE_EXHAUSTED');
                const isMissingAudio = error.message.includes('Google TTS response missing audio data');
                
                if (isRateLimit) {
                    console.warn(`⚠️ API ${entry.name} saturada (429)`);
                    keyRetries = -1;
                    await new Promise(resolve => setTimeout(resolve, 1000));
                } else if (isMissingAudio && keyRetries > 0) {
                    console.warn(`⚠️ Error con API ${entry.name}: ${error.message}. Reintentando...`);
                    await new Promise(resolve => setTimeout(resolve, 2000));
                    keyRetries--;
                } else {
                    console.warn(`⚠️ Error con API ${entry.name}: ${error.message}`);
                    keyRetries = -1;
                }
            }
        }
    }
    throw lastError || new Error('All API keys failed for TTS');
}

// ==============================
// GOOGLE CLOUD TTS (Standard / Neural2 / WaveNet)
// ==============================

const CLOUD_TTS_LANG_MAP = {
    'es': 'es-ES', 'en': 'en-US', 'fr': 'fr-FR', 'de': 'de-DE',
    'pt': 'pt-BR', 'it': 'it-IT', 'ru': 'ru-RU',
    'zh': 'cmn-CN', 'ko': 'ko-KR', 'ja': 'ja-JP'
};

const CLOUD_TTS_VOICES = {
    neural2: {
        'es-ES': { male: 'es-ES-Neural2-B', female: 'es-ES-Neural2-A' },
        'en-US': { male: 'en-US-Neural2-D', female: 'en-US-Neural2-C' },
        'fr-FR': { male: 'fr-FR-Neural2-B', female: 'fr-FR-Neural2-A' },
        'de-DE': { male: 'de-DE-Neural2-B', female: 'de-DE-Neural2-A' },
        'pt-BR': { male: 'pt-BR-Neural2-B', female: 'pt-BR-Neural2-A' },
        'it-IT': { male: 'it-IT-Neural2-C', female: 'it-IT-Neural2-A' },
        'ru-RU': { male: 'ru-RU-Wavenet-B', female: 'ru-RU-Wavenet-A' },
        'cmn-CN': { male: 'cmn-CN-Wavenet-B', female: 'cmn-CN-Wavenet-A' },
        'ko-KR': { male: 'ko-KR-Neural2-C', female: 'ko-KR-Neural2-A' },
        'ja-JP': { male: 'ja-JP-Neural2-C', female: 'ja-JP-Neural2-B' }
    },
    wavenet: {
        'es-ES': { male: 'es-ES-Wavenet-B', female: 'es-ES-Wavenet-A' },
        'en-US': { male: 'en-US-Wavenet-D', female: 'en-US-Wavenet-C' },
        'fr-FR': { male: 'fr-FR-Wavenet-B', female: 'fr-FR-Wavenet-A' },
        'de-DE': { male: 'de-DE-Wavenet-B', female: 'de-DE-Wavenet-A' },
        'pt-BR': { male: 'pt-BR-Wavenet-B', female: 'pt-BR-Wavenet-A' },
        'it-IT': { male: 'it-IT-Wavenet-C', female: 'it-IT-Wavenet-A' },
        'ru-RU': { male: 'ru-RU-Wavenet-B', female: 'ru-RU-Wavenet-A' },
        'cmn-CN': { male: 'cmn-CN-Wavenet-B', female: 'cmn-CN-Wavenet-A' },
        'ko-KR': { male: 'ko-KR-Wavenet-C', female: 'ko-KR-Wavenet-A' },
        'ja-JP': { male: 'ja-JP-Wavenet-C', female: 'ja-JP-Wavenet-B' }
    }
};

const cloudTTSClients = new Map();

function getCloudTTSClient(apiKey) {
    if (!apiKey) throw new Error('No hay API key configurada para Google Cloud TTS');
    if (!cloudTTSClients.has(apiKey)) {
        cloudTTSClients.set(apiKey, new textToSpeech.TextToSpeechClient({ apiKey }));
    }
    return cloudTTSClients.get(apiKey);
}

async function generateSingleCloudTTS(text, outputPath, lang, cloudVoice = 'male', voiceType = 'neural2', clientKeys = null) {
    if (!text || !text.trim()) throw new Error("Text is empty");

    const langCode = CLOUD_TTS_LANG_MAP[lang] || 'en-US';
    const tier = voiceType === 'wavenet' ? 'wavenet' : 'neural2';

    // Determine voice name
    let voiceName;
    if (cloudVoice === 'male' || cloudVoice === 'female' || cloudVoice === 'auto' || !cloudVoice) {
        const gender = (cloudVoice === 'female') ? 'female' : 'male';
        voiceName = CLOUD_TTS_VOICES[tier]?.[langCode]?.[gender] || `${langCode}-${tier === 'wavenet' ? 'Wavenet' : 'Neural2'}-B`;
    } else {
        voiceName = cloudVoice; // User-specified exact voice name
    }

    const charCount = text.length;

    const usageState = getTrackedUsageState('tts');
    const skipFreeApis = usageState?.preferPrimary;

    let keysToTry = [];
    if (!skipFreeApis) {
        const freeApiEntries = getFreeGoogleAPIKeys(clientKeys);
        for (let i = freeApiEntries.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [freeApiEntries[i], freeApiEntries[j]] = [freeApiEntries[j], freeApiEntries[i]];
        }
        keysToTry = [...freeApiEntries];
    }
    const primaryKey = getPrimaryGoogleAPIKey(clientKeys);
    if (primaryKey) {
        keysToTry.push({ key: primaryKey, name: GOOGLE_PRIMARY_API_NAME, isPrimary: true });
    }
    if (keysToTry.length === 0) throw new Error('No hay API keys configuradas para Cloud TTS.');

    let lastError = null;
    for (const entry of keysToTry) {
        try {
            const client = getCloudTTSClient(entry.key);
            console.log(`🔊 Generating Cloud TTS for ${lang} using ${entry.name} voice=${voiceName}...`);

            const [response] = await client.synthesizeSpeech({
                input: { text: text },
                voice: { languageCode: langCode, name: voiceName },
                audioConfig: {
                    audioEncoding: 'LINEAR16',
                    sampleRateHertz: 24000,
                    speakingRate: 1.0
                }
            });

            if (!response.audioContent || response.audioContent.length < 100) {
                throw new Error('Cloud TTS response empty or too short');
            }

            await writeFile(outputPath, response.audioContent);
            return { isPrimary: entry.isPrimary || false, model: `cloud-tts-${tier}`, usage: null, characters: charCount };

        } catch (error) {
            lastError = error;
            const isRateLimit = error.message?.includes('429') || error.code === 8 || error.message?.includes('RESOURCE_EXHAUSTED');
            if (isRateLimit) {
                console.warn(`⚠️ Cloud TTS API ${entry.name} saturada (429)`);
                await new Promise(resolve => setTimeout(resolve, 1000));
            } else {
                console.warn(`⚠️ Cloud TTS error con ${entry.name}: ${error.message}`);
            }
        }
    }
    throw lastError || new Error('All API keys failed for Cloud TTS');
}

async function mergeAudioFiles(files, outputPath) {
    return new Promise((resolve, reject) => {
        const missingFiles = files.filter(f => !fs.existsSync(f));
        if (missingFiles.length > 0) return reject(new Error(`Missing files for merge: ${missingFiles.join(', ')}`));

        const listFilePath = outputPath + '.list.txt';
        const fileContent = files.map(f => `file '${path.basename(f)}'`).join('\n');
        fs.writeFileSync(listFilePath, fileContent);

        const ffmpeg = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listFilePath, '-c', 'copy', outputPath]);
        let stderr = '';
        ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
        ffmpeg.on('close', (code) => {
            if (fs.existsSync(listFilePath)) try { fs.unlinkSync(listFilePath); } catch (e) {}
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg merge failed: ${stderr.slice(-200)}`));
        });
        ffmpeg.on('error', (err) => {
            if (fs.existsSync(listFilePath)) try { fs.unlinkSync(listFilePath); } catch (e) {}
            reject(err);
        });
    });
}

// ==============================
// HELPERS PARA AUDIO SEGMENT-BASED
// ==============================

async function generateSilence(outputPath, duration) {
    if (duration < 0.01) duration = 0.01;
    await new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', String(duration), '-acodec', 'pcm_s16le', '-ar', '24000', '-ac', '1', outputPath]);
        let stderr = '';
        p.stderr.on('data', d => stderr += d);
        p.on('close', c => c === 0 ? resolve() : reject(new Error(`Silence gen failed: ${stderr.slice(-100)}`)));
    });
}

async function adjustAudioSpeed(inPath, outPath, targetDuration) {
    let currentDur = 0;
    await new Promise(r => {
        const p = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', inPath]);
        let o = ''; p.stdout.on('data', d => o += d); p.on('close', () => { currentDur = parseFloat(o); r(); });
    });
    if (currentDur <= 0 || isNaN(currentDur)) {
        await generateSilence(outPath, targetDuration);
        return;
    }
    const speedFactor = currentDur / targetDuration;

    // If we'd need to slow down to less than 0.45x, the target is likely wrong.
    // Cap to a minimum 0.75x speed to avoid weird slow-mo audio.
    let effectiveTarget = targetDuration;
    if (speedFactor < 0.45) {
        effectiveTarget = currentDur / 0.75;
        console.warn(`⚠️ Speed factor ${speedFactor.toFixed(2)} too extreme for ${path.basename(inPath)} (${currentDur.toFixed(1)}s → ${targetDuration.toFixed(1)}s). Capping to ${effectiveTarget.toFixed(1)}s`);
    }
    const effectiveSpeed = currentDur / effectiveTarget;

    // Build filter chain: speed adjust then pad to exact target duration
    // apad fills with silence if audio is slightly short after speed adjust
    // We do NOT use atrim to cut — instead we always speed-adjust to avoid cutting words

    if (Math.abs(effectiveSpeed - 1.0) < 0.01) {
        // Speed is virtually identical (within 1%), just pad to exact duration
        const padFilter = `apad,atrim=0:${targetDuration}`;
        await new Promise((resolve, reject) => {
            const p = spawn('ffmpeg', ['-y', '-i', inPath, '-af', padFilter, '-ar', '24000', '-ac', '1', '-acodec', 'pcm_s16le', outPath]);
            let stderr = '';
            p.stderr.on('data', d => stderr += d);
            p.on('close', c => c === 0 ? resolve() : reject(new Error(`Pad/trim failed: ${stderr.slice(-200)}`)));
        });
        return;
    }
    let filters = [];
    let s = effectiveSpeed;
    while (s > 2.0) { filters.push('atempo=2.0'); s /= 2.0; }
    while (s < 0.5) { filters.push('atempo=0.5'); s /= 0.5; }
    filters.push(`atempo=${s}`);
    // Pad with silence if slightly short, trim to exact target duration.
    // This prevents cumulative drift across segments.
    filters.push('apad');
    filters.push(`atrim=0:${targetDuration}`);
    await new Promise((resolve, reject) => {
        const p = spawn('ffmpeg', ['-y', '-i', inPath, '-af', filters.join(','), '-ar', '24000', '-ac', '1', '-acodec', 'pcm_s16le', outPath]);
        let stderr = '';
        p.stderr.on('data', d => stderr += d);
        p.on('close', c => c === 0 ? resolve() : reject(new Error(`Speed adjust failed: ${stderr.slice(-200)}`)));
    });
}

async function translateSegmentsBatch(segments, lang, langName, options) {
    const { translationModel, podcastStyle, clientKeys, costTracker, sameLanguage } = options;
    const segmentTexts = segments.map(s => s.text);

    const BATCH = 50;
    const allTranslated = [];

    for (let bStart = 0; bStart < segmentTexts.length; bStart += BATCH) {
        const batch = segmentTexts.slice(bStart, bStart + BATCH);

        let prompt;
        if (sameLanguage && podcastStyle) {
            prompt = `Rewrite each of the following transcript segments in a conversational podcast style in ${langName}.
Make it sound natural, casual, and engaging — like a real podcast host talking to their audience.
Add natural speech flow, but do NOT change the meaning or add new information.
Keep each segment roughly the same length as the original.
Return ONLY a valid JSON array of strings. Each element is the rewritten version of the corresponding input segment at the same index.
Do NOT add, remove, or reorder segments. Return exactly ${batch.length} strings.
OUTPUT ONLY THE JSON ARRAY. No markdown code blocks, no explanation.

${JSON.stringify(batch)}`;
        } else {
            prompt = `Translate each of the following transcript segments to ${langName}.
Return ONLY a valid JSON array of strings. Each element is the translation of the corresponding input segment at the same index.
Do NOT add, remove, or reorder segments. Return exactly ${batch.length} translated strings.
${podcastStyle ? 'Keep the translation conversational and natural sounding.' : 'Maintain the original tone and style.'}
OUTPUT ONLY THE JSON ARRAY. No markdown code blocks, no explanation.

${JSON.stringify(batch)}`;
        }

        const selectedModel = translationModel || GEMINI_TEXT_MODEL;
        let result;
        let usedKeyType = 'free';
        let retries = 3;
        while (retries > 0) {
            try {
                const forcePrimary = (retries === 1);
                const aiResult = await getGoogleAI(selectedModel, { context: 'llm', forcePrimary, clientKeys });
                usedKeyType = aiResult.keyType;
                result = await aiResult.model.generateContent(prompt);
                break;
            } catch (err) {
                retries--;
                if (retries === 0) throw err;
                await new Promise(r => setTimeout(r, (4 - retries) * 2000));
            }
        }

        // Track cost if PRINCIPAL was used
        if (usedKeyType === 'primary' && costTracker) {
            const usage = result.response.usageMetadata;
            if (usage) {
                trackCost(costTracker, selectedModel, usage.promptTokenCount, usage.candidatesTokenCount);
            }
        }

        let responseText = result.response.text().trim();
        responseText = responseText.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?\s*```$/i, '').trim();

        const translated = JSON.parse(responseText);
        if (!Array.isArray(translated) || translated.length !== batch.length) {
            throw new Error(`Translation returned ${translated?.length} segments, expected ${batch.length}`);
        }
        allTranslated.push(...translated);
    }

    return allTranslated;
}

async function generateGoogleTTSWithSplitting(text, outputPath, lang, selectedVoice = 'Kore', modelName = GEMINI_TTS_MODEL_FLASH, randomVoice = false, disableParagraphSplitting = false, keepTempFiles = false, sectionUniqueId = '', clientKeys = null) {
    let rawParagraphs;
    if (disableParagraphSplitting) {
        rawParagraphs = [text];
    } else {
        rawParagraphs = text.split(/\n\s*\n/).filter(p => p.trim().length > 0);
    }
    
    const MAX_CHARS = 1600;
    const MAX_WORDS = 300;
    let paragraphs = [];

    for (let i = 0; i < rawParagraphs.length; i++) {
        const currentPara = rawParagraphs[i].trim();
        
        if (disableParagraphSplitting && (currentPara.length > 4000)) {
            let subParts = currentPara.split(/\n\s*\n/).filter(p => p.trim().length > 0);
            if (subParts.length <= 1) subParts = currentPara.split(/\n/).filter(p => p.trim().length > 0);
            if (subParts.length <= 1) subParts = currentPara.match(/.{1,4000}(?:\s|$)/g) || [currentPara];
            for (const sub of subParts) {
                if (sub !== currentPara) rawParagraphs.push(sub);
                else break;
            }
            if (subParts.length > 1 || subParts[0] !== currentPara) continue;
        }

        if (i + 1 < rawParagraphs.length) {
            const nextPara = rawParagraphs[i+1].trim();
            const combined = currentPara + "\n\n" + nextPara;
            const combinedWordCount = combined.split(/\s+/).length;
            if (combined.length <= MAX_CHARS && combinedWordCount <= MAX_WORDS) {
                paragraphs.push(combined);
                i++;
            } else {
                paragraphs.push(currentPara);
            }
        } else {
            paragraphs.push(currentPara);
        }
    }
    
    if (paragraphs.length === 0) paragraphs = [text];

    const tempFiles = [];
    const tempDir = path.dirname(outputPath);

    const googleVoicesList = [
        'Zephyr', 'Kore', 'Leda', 'Aoede', 'Callirrhoe', 'Autonoe', 'Algieba', 'Despina', 'Erinome', 'Algenib',
        'Rasalgethi', 'Laomedeia', 'Achernar', 'Gacrux', 'Pulcherrima', 'Achird', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat',
        'Puck', 'Charon', 'Fenrir', 'Orus', 'Enceladus', 'Iapetus', 'Umbriel', 'Alnilam', 'Schedar', 'Zubenelgenubi'
    ];

    try {
        const cleanParagraphs = paragraphs.map(p => p.trim()).filter(p => p.length > 0);
        const safeUniqueId = sectionUniqueId ? `_${sectionUniqueId}` : '';
        const filePaths = cleanParagraphs.map((_, i) => path.join(tempDir, `temp_tts_${lang}${safeUniqueId}_part_${i}.wav`));
        filePaths.forEach(f => tempFiles.push(f));

        const tasks = cleanParagraphs.map((paragraph, i) => {
            return async () => {
                const filePath = filePaths[i];
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    if (stats.size > 100) {
                        console.log(`⏩ Skipping existing part ${i} for ${lang}`);
                        return;
                    }
                }
                let voiceToUse = selectedVoice;
                if (randomVoice) {
                    voiceToUse = googleVoicesList[Math.floor(Math.random() * googleVoicesList.length)];
                }
                await generateSingleGoogleTTS(paragraph, filePath, lang, voiceToUse, modelName, clientKeys);
            };
        });

        const BATCH_SIZE = 3;
        for (let i = 0; i < tasks.length; i += BATCH_SIZE) {
            const batch = tasks.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(task => task()));
            if (i + BATCH_SIZE < tasks.length) await new Promise(r => setTimeout(r, 1000));
        }

        if (tempFiles.length === 0) throw new Error("No audio generated from text");
        await mergeAudioFiles(tempFiles, outputPath);

        if (!keepTempFiles) {
            for (const file of tempFiles) {
                if (fs.existsSync(file)) try { fs.unlinkSync(file); } catch(e) {}
            }
        }
    } catch (error) {
        console.error(`❌ Error in generateGoogleTTSWithSplitting for ${lang}:`, error);
        throw error;
    }
}

// ==============================
// AUTENTICACIÓN FIREBASE
// ==============================

async function verifyFirebaseToken(idToken) {
    const response = await fetch(
        `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${FIREBASE_API_KEY}`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ idToken })
        }
    );
    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    if (!data.users || !data.users.length) throw new Error('Usuario no encontrado');
    const user = data.users[0];
    return {
        uid: user.localId,
        email: user.email,
        name: user.displayName,
        picture: user.photoUrl,
    };
}

// Auth middleware — protege todas las rutas /api/*
function requireAuth(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'No autorizado. Inicia sesión.' });
    }
    const token = authHeader.split(' ')[1];
    verifyFirebaseToken(token)
        .then(user => {
            req.user = user;
            next();
        })
        .catch(() => {
            res.status(401).json({ error: 'Token inválido o expirado. Inicia sesión de nuevo.' });
        });
}

app.use('/api', requireAuth);

// ==============================
// ENDPOINTS
// ==============================

// Check video exists
app.get('/api/check-video-exists', (req, res) => {
    try {
        const { videoName } = req.query;
        if (!videoName) return res.status(400).json({ exists: false, error: 'Nombre de video requerido' });
        
        const name = path.parse(videoName).name;
        const outputDir = path.join(globalOutputDir, name);
        
        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir);
            const hasOriginalVideo = files.some(f => f.startsWith('original_video'));
            if (hasOriginalVideo) return res.json({ exists: true, message: 'Proyecto encontrado con video original.' });
        }
        res.json({ exists: false });
    } catch (error) {
        res.status(500).json({ exists: false, error: error.message });
    }
});

// Cost history API
app.get('/api/costs', (req, res) => {
    const costs = loadCosts();
    res.json({ costs, mxnRate: MXN_RATE });
});

app.delete('/api/costs', (req, res) => {
    try {
        fs.writeFileSync(COSTS_FILE, '[]', 'utf8');
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Settings
app.get('/api/settings/output-dir', (req, res) => {
    res.json({ outputsDir: globalOutputDir });
});

app.post('/api/settings/pick-output-dir', async (req, res) => {
    try {
        // Open native Windows folder picker via PowerShell
        const ps = spawn('powershell', ['-NoProfile', '-Command', `
            Add-Type -AssemblyName System.Windows.Forms
            $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
            $dialog.Description = "Seleccionar carpeta de outputs"
            $dialog.SelectedPath = "${globalOutputDir.replace(/\\/g, '\\\\')}"
            $dialog.ShowNewFolderButton = $true
            if ($dialog.ShowDialog() -eq 'OK') { Write-Output $dialog.SelectedPath }
            else { Write-Output "" }
        `]);
        let output = '';
        ps.stdout.on('data', d => output += d.toString());
        ps.on('close', (code) => {
            const selected = output.trim();
            if (!selected) return res.json({ cancelled: true, outputsDir: globalOutputDir });
            globalOutputDir = selected;
            if (!fs.existsSync(globalOutputDir)) fs.mkdirSync(globalOutputDir, { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({ outputsDir: globalOutputDir }, null, 2));
            res.json({ success: true, outputsDir: globalOutputDir });
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/settings/output-dir', (req, res) => {
    try {
        const newDir = req.body.outputsDir;
        if (newDir) {
            globalOutputDir = newDir;
            if (!fs.existsSync(globalOutputDir)) fs.mkdirSync(globalOutputDir, { recursive: true });
            fs.writeFileSync(settingsPath, JSON.stringify({ outputsDir: globalOutputDir }, null, 2));
            res.json({ success: true, outputsDir: globalOutputDir });
        } else {
            res.status(400).json({ error: 'Falta outputsDir' });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==============================
// TRADUCCIÓN AUTOMÁTICA DE VIDEO
// ==============================

app.post('/api/translate-video', upload.fields([{ name: 'video', maxCount: 1 }, { name: 'music', maxCount: 1 }]), async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendStatus = (status, progress = null, completed = false, error = null) => {
        const data = JSON.stringify({ status, progress, completed, error });
        res.write(`data: ${data}\n\n`);
    };

    try {
        // Parse client API keys from request
        let clientKeys = null;
        try { clientKeys = JSON.parse(req.body.clientApiKeys || 'null'); } catch (e) {}
        if (!clientKeys || !Object.keys(clientKeys).length) {
            sendStatus('Error: No se encontraron API Keys. Configúralas en el panel de API Keys.', 0, true, 'NO_API_KEYS');
            return res.end();
        }

        let videoPath;
        let videoName;
        let musicFile = req.files && req.files['music'] ? req.files['music'][0] : null;

        if (req.body.retryVideoName) {
            videoName = path.parse(req.body.retryVideoName).name;
            const outputDir = path.join(globalOutputDir, videoName);
            if (fs.existsSync(outputDir)) {
                const files = fs.readdirSync(outputDir);
                const originalVideo = files.find(f => f.startsWith('original_video.'));
                if (originalVideo) {
                    videoPath = path.join(outputDir, originalVideo);
                    console.log(`🔄 Retrying with existing video: ${videoPath}`);
                }
            }
            if (!videoPath) throw new Error('Could not find existing video for retry. Please upload the file again.');
        } else {
            if (!req.files || !req.files['video']) throw new Error('No video file uploaded');
            const videoFile = req.files['video'][0];
            videoPath = videoFile.path;
            videoName = path.parse(videoFile.originalname).name;
        }

        // Limpiar temp
        try {
            const tempDir = './temp';
            if (fs.existsSync(tempDir)) {
                const files = fs.readdirSync(tempDir);
                const currentFiles = [path.basename(videoPath), musicFile ? path.basename(musicFile.path) : null].filter(Boolean);
                for (const file of files) {
                    if (!currentFiles.includes(file)) {
                        try {
                            const filePath = path.join(tempDir, file);
                            if (fs.lstatSync(filePath).isFile()) fs.unlinkSync(filePath);
                        } catch (err) {}
                    }
                }
            }
        } catch (cleanupError) {}

        const outputDir = path.join(globalOutputDir, videoName);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        if (!req.body.retryVideoName) {
            const ext = path.extname(videoPath);
            const savedVideoPath = path.join(outputDir, `original_video${ext}`);
            try { fs.copyFileSync(videoPath, savedVideoPath); } catch (e) {}
        }

        sendStatus('Video subido. Iniciando procesamiento...', 10);

        // 1. Extract Audio
        const audioPath = path.join(outputDir, 'original_audio.mp3');
        if (fs.existsSync(audioPath)) {
            sendStatus('Audio original encontrado, saltando extracción...', 20);
        } else {
            sendStatus('Extrayendo audio...', 20);
            await new Promise((resolve, reject) => {
                const ffmpeg = spawn('ffmpeg', ['-y', '-i', videoPath, '-vn', '-acodec', 'libmp3lame', audioPath]);
                let stderr = '';
                ffmpeg.stderr.on('data', (data) => { stderr += data.toString(); });
                ffmpeg.on('error', (err) => reject(err.code === 'ENOENT' ? new Error('FFmpeg no está instalado o no se encuentra en el PATH.') : err));
                ffmpeg.on('close', (code) => code === 0 ? resolve() : reject(new Error(`FFmpeg error extracting audio (code ${code}): ${stderr.slice(-300)}`)));
            });
        }

        // Get Video Duration
        let videoDuration = 0;
        await new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath]);
            let output = '';
            ffprobe.stdout.on('data', (data) => output += data.toString());
            ffprobe.on('close', (code) => {
                if (code === 0) { videoDuration = parseFloat(output); resolve(); }
                else reject(new Error('FFprobe error'));
            });
        });

        const endScreenSeconds = Math.max(0, parseInt(req.body.endScreenSeconds) || 0);

        // 2. Transcribe
        let transcriptionResult = null;
        let transcriptionJsonPath = path.join(outputDir, 'transcription.json');
        let originalText = '';

        // Gemini transcription
        if (fs.existsSync(transcriptionJsonPath)) {
            sendStatus('Transcripción encontrada, cargando...', 30);
            try {
                transcriptionResult = JSON.parse(fs.readFileSync(transcriptionJsonPath, 'utf8'));
                // Re-transcribe if segments are missing or empty
                if (!transcriptionResult.segments || transcriptionResult.segments.length === 0) {
                    console.warn('⚠️ transcription.json sin segmentos, re-transcribiendo...');
                    transcriptionResult = null;
                }
            }
            catch (e) { console.error('Error leyendo transcripción existente, re-transcribiendo...'); }
        }

        if (!transcriptionResult) {
            const transcriptionMethod = req.body.transcriptionMethod || 'gemini';
            
            if (transcriptionMethod === 'whisper') {
                sendStatus('Transcribiendo audio con Whisper Local (GPU)...', 30);
                transcriptionResult = await transcribeWithWhisperLocal(audioPath);
            } else {
                sendStatus('Transcribiendo audio con Gemini...', 30);
                transcriptionResult = await transcribeAudioWithGemini(audioPath, clientKeys);
            }
            // Split oversized segments, then fix timestamp jumps
            if (transcriptionResult.segments && transcriptionResult.segments.length > 0) {
                transcriptionResult.segments = splitOversizedSegments(transcriptionResult.segments);
                transcriptionResult.segments = fixTimestampJumps(transcriptionResult.segments);
            }
            fs.writeFileSync(transcriptionJsonPath, JSON.stringify(transcriptionResult, null, 2));
        }

        // Filter out empty segments (music, SFX, pauses) — their time becomes natural silence via gaps
        if (transcriptionResult.segments && transcriptionResult.segments.length > 0) {
            const before = transcriptionResult.segments.length;
            transcriptionResult.segments = transcriptionResult.segments.filter(s => s.text && s.text.trim());
            const after = transcriptionResult.segments.length;
            if (before !== after) {
                console.log(`🧹 Filtrados ${before - after} segmentos vacíos (${before} → ${after})`);
            }
        }

        // Filter segments that fall in the end screen zone (music/silence at the end)
        if (endScreenSeconds > 0 && videoDuration > 0 && transcriptionResult.segments?.length > 0) {
            const speechCutoff = videoDuration - endScreenSeconds;
            const before = transcriptionResult.segments.length;
            transcriptionResult.segments = transcriptionResult.segments.filter(s => s.start < speechCutoff);
            const after = transcriptionResult.segments.length;
            if (before !== after) {
                console.log(`🔇 Filtrados ${before - after} segmentos en zona de pantalla final (start >= ${speechCutoff.toFixed(1)}s)`);
            }
            // Rebuild transcript from filtered segments
            transcriptionResult.transcript = transcriptionResult.segments.map(s => s.text).join(' ');
        }

        originalText = transcriptionResult.transcript;
        if (!originalText) throw new Error('La transcripción del audio falló o devolvió texto vacío.');

        sendStatus('Transcripción completada. Traduciendo...', 50);

        // 3. Translate and Generate Audio
        let languages = ['es', 'en', 'fr', 'de', 'pt', 'it', 'ru', 'zh', 'ko', 'ja'];
        if (req.body.targetLanguages) {
            try {
                const userLangs = JSON.parse(req.body.targetLanguages);
                if (Array.isArray(userLangs)) languages = userLangs;
            } catch (e) {}
        }

        const langNames = {
            'es': 'Spanish', 'en': 'English', 'fr': 'French', 'de': 'German',
            'pt': 'Portuguese', 'it': 'Italian', 'ru': 'Russian',
            'zh': 'Chinese', 'ko': 'Korean', 'ja': 'Japanese'
        };

        const voiceMap = {
            'es': 'es-ES-AlvaroNeural', 'en': 'en-US-ChristopherNeural', 'fr': 'fr-FR-HenriNeural',
            'de': 'de-DE-ConradNeural', 'pt': 'pt-BR-AntonioNeural', 'it': 'it-IT-DiegoNeural',
            'ru': 'ru-RU-DmitryNeural', 'zh': 'zh-CN-YunxiNeural', 'ko': 'ko-KR-InJoonNeural',
            'ja': 'ja-JP-KeitaNeural'
        };

        let progress = 50;
        const progressStep = 40 / languages.length;
        const costTracker = createCostTracker();

        for (const lang of languages) {
            const finalAudioPath = path.join(outputDir, `${langNames[lang]}.wav`);

            if (fs.existsSync(finalAudioPath)) {
                console.log(`✅ Audio final para ${langNames[lang]} ya existe, saltando.`);
                sendStatus(`Audio para ${langNames[lang]} ya existe, saltando...`, progress + progressStep);
                progress += progressStep;
                continue;
            }

            sendStatus(`Traduciendo a ${langNames[lang]}...`, progress);

            let translatedText = "";
            const langScriptPath = path.join(outputDir, `script_${lang}.txt`);

            if (transcriptionResult.segments && transcriptionResult.segments.length > 0) {
                // ====== SEGMENT-BASED: cada segmento con timing exacto ======
                console.log(`🎯 Modo Segment-Based para ${langNames[lang]}`);

                // 1. Traducir segmentos
                let translatedTexts;
                const segTransPath = path.join(outputDir, `segments_${lang}.json`);

                if (fs.existsSync(segTransPath)) {
                    translatedTexts = JSON.parse(fs.readFileSync(segTransPath, 'utf8'));
                    if (translatedTexts.length !== transcriptionResult.segments.length) {
                        console.log(`⚠️ Cache de traducción (${translatedTexts.length}) no coincide con segmentos (${transcriptionResult.segments.length}), re-traduciendo...`);
                        translatedTexts = null;
                    }
                }
                if (!translatedTexts) {
                    const detectedLang = transcriptionResult.language || null;
                    const isPodcast = req.body.podcastStyle === 'true';
                    if (detectedLang && detectedLang === lang && !isPodcast) {
                        console.log(`🔄 Idioma detectado (${detectedLang}) coincide con target (${lang}), usando textos originales`);
                        sendStatus(`Idioma original detectado: ${langNames[lang]}. Usando transcripción original...`, progress);
                        translatedTexts = transcriptionResult.segments.map(s => s.text);
                    } else {
                        if (detectedLang && detectedLang === lang && isPodcast) {
                            console.log(`🎙️ Mismo idioma (${lang}) pero estilo podcast activo, reescribiendo...`);
                            sendStatus(`Reescribiendo en estilo podcast para ${langNames[lang]}...`, progress);
                        } else {
                            sendStatus(`Traduciendo segmentos a ${langNames[lang]}...`, progress);
                        }
                        translatedTexts = await translateSegmentsBatch(
                            transcriptionResult.segments, lang, langNames[lang],
                            {
                                translationModel: req.body.translationModel,
                                podcastStyle: isPodcast,
                                sameLanguage: detectedLang && detectedLang === lang,
                                clientKeys,
                                costTracker
                            }
                        );
                    }
                    fs.writeFileSync(segTransPath, JSON.stringify(translatedTexts, null, 2));
                }

                translatedText = translatedTexts.join('\n');
                fs.writeFileSync(langScriptPath, translatedText);

                // Check text_only
                const segTtsProvider = req.body.ttsProvider || 'google';
                if (segTtsProvider === 'text_only') {
                    progress += progressStep;
                    sendStatus(`Texto traducido para ${langNames[lang]} guardado.`, progress);
                    continue;
                }

                // 2. Generar audio por segmento con timing exacto
                const segGoogleVoice = req.body.googleVoice || 'Kore';
                const segCloudVoice = req.body.cloudVoice || 'male';
                const segIsPro = segTtsProvider === 'google_pro';
                const segIsCloud = segTtsProvider === 'google_cloud' || segTtsProvider === 'google_wavenet';
                const segCloudVoiceType = segTtsProvider === 'google_wavenet' ? 'wavenet' : 'neural2';
                const segTtsModel = segIsPro ? GEMINI_TTS_MODEL_PRO : GEMINI_TTS_MODEL_FLASH;

                const segAudioOutputPath = path.join(outputDir, `audio_${lang}.wav`);

                if (!fs.existsSync(segAudioOutputPath)) {
                    const segDir = path.join(outputDir, `segments_${lang}`);
                    if (!fs.existsSync(segDir)) fs.mkdirSync(segDir, { recursive: true });

                    const segs = transcriptionResult.segments;
                    const GROUP_SIZE = Math.max(1, Math.min(12, parseInt(req.body.groupSize) || 3));
                    const SEG_BATCH = 9;  // Parallel TTS calls
                    const voicesList = ['Zephyr','Kore','Leda','Aoede','Callirrhoe','Autonoe','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Gacrux','Pulcherrima','Achird','Vindemiatrix','Sadachbia','Sadaltager','Sulafat','Puck','Charon','Fenrir','Orus','Enceladus','Iapetus','Umbriel','Alnilam','Schedar','Zubenelgenubi'];

                    // Build groups of GROUP_SIZE segments
                    // Build groups of GROUP_SIZE segments, breaking on significant gaps
                    // so that silences between segments are preserved as actual gaps
                    const GAP_BREAK_THRESHOLD = 1.5; // seconds — break group if gap between consecutive segments exceeds this
                    const groups = [];
                    let gi = 0;
                    while (gi < segs.length) {
                        let groupEnd = Math.min(gi + GROUP_SIZE, segs.length);

                        // Check for significant gaps within the would-be group and break early
                        for (let j = gi + 1; j < groupEnd; j++) {
                            const intraGap = segs[j].start - segs[j - 1].end;
                            if (intraGap > GAP_BREAK_THRESHOLD) {
                                groupEnd = j; // Break the group before this gap
                                break;
                            }
                        }

                        const groupSegs = segs.slice(gi, groupEnd);
                        const groupTexts = groupSegs.map((_, idx) => translatedTexts[gi + idx]).filter(t => t && t.trim());
                        const groupStart = groupSegs[0].start;
                        const gEnd = groupSegs[groupSegs.length - 1].end;
                        groups.push({
                            index: groups.length,
                            startSegIdx: gi,
                            endSegIdx: groupEnd - 1,
                            text: groupTexts.join(' '),
                            start: groupStart,
                            end: gEnd,
                            duration: gEnd - groupStart
                        });
                        gi = groupEnd;
                    }
                    console.log(`📊 ${segs.length} segmentos → ${groups.length} grupos de ~${GROUP_SIZE} para TTS`);

                    // Contar cuántos ya están hechos para el resume
                    let doneCount = 0;
                    for (const g of groups) {
                        const adjPath = path.join(segDir, `adj_g${g.index}.wav`);
                        if (fs.existsSync(adjPath) && fs.statSync(adjPath).size > 100) doneCount++;
                    }
                    if (doneCount > 0) {
                        sendStatus(`Retomando: ${doneCount}/${groups.length} grupos ya generados para ${langNames[lang]}`, progress);
                    }

                    // Generar TTS por grupo en batches paralelos
                    for (let bStart = 0; bStart < groups.length; bStart += SEG_BATCH) {
                        const bEnd = Math.min(bStart + SEG_BATCH, groups.length);
                        const batchPromises = [];

                        for (let gi = bStart; gi < bEnd; gi++) {
                            batchPromises.push((async () => {
                                const group = groups[gi];
                                let groupDuration = group.duration;
                                const rawPath = path.join(segDir, `raw_g${group.index}.wav`);
                                const adjPath = path.join(segDir, `adj_g${group.index}.wav`);

                                // Guard: if duration is too short for the text, estimate
                                const textLen = (group.text || '').length;
                                if (groupDuration < 0.5 && textLen > 15) {
                                    console.warn(`⚠️ Group ${group.index} duration ${groupDuration.toFixed(2)}s too short for ${textLen} chars. Estimating.`);
                                    groupDuration = Math.max(1.5, textLen / 14);
                                } else if (groupDuration <= 0) {
                                    groupDuration = Math.max(1.5, textLen / 14);
                                }

                                // Ya está hecho y es válido, skip
                                if (fs.existsSync(adjPath) && fs.statSync(adjPath).size > 100) return;

                                // Limpiar archivos corruptos/vacíos
                                if (fs.existsSync(rawPath) && fs.statSync(rawPath).size < 100) {
                                    try { fs.unlinkSync(rawPath); } catch(e) {}
                                }
                                if (fs.existsSync(adjPath) && fs.statSync(adjPath).size < 100) {
                                    try { fs.unlinkSync(adjPath); } catch(e) {}
                                }

                                if (group.text && group.text.trim() && groupDuration > 0.1) {
                                    let ttsRetries = 2;
                                    while (ttsRetries >= 0) {
                                        try {
                                            if (!fs.existsSync(rawPath) || fs.statSync(rawPath).size < 100) {
                                                if (segIsCloud) {
                                                    const cloudResult = await generateSingleCloudTTS(group.text, rawPath, lang, segCloudVoice, segCloudVoiceType, clientKeys);
                                                    if (cloudResult?.isPrimary) trackCloudTTSCost(costTracker, cloudResult.model, cloudResult.characters);
                                                } else {
                                                    let voice = segGoogleVoice;
                                                    if (req.body.randomVoice === 'true') {
                                                        voice = voicesList[Math.floor(Math.random() * voicesList.length)];
                                                    }
                                                    const ttsResult = await generateSingleGoogleTTS(group.text, rawPath, lang, voice, segTtsModel, clientKeys);
                                                    if (ttsResult?.isPrimary && ttsResult.usage) {
                                                        trackCost(costTracker, segTtsModel, ttsResult.usage.promptTokenCount, ttsResult.usage.candidatesTokenCount);
                                                    }
                                                }
                                            }
                                            await adjustAudioSpeed(rawPath, adjPath, groupDuration);
                                            break;
                                        } catch (segErr) {
                                            ttsRetries--;
                                            console.warn(`⚠️ Grupo ${group.index} falló (${segErr.message}), reintentos restantes: ${ttsRetries + 1}`);
                                            if (fs.existsSync(rawPath)) try { fs.unlinkSync(rawPath); } catch(e) {}
                                            if (fs.existsSync(adjPath)) try { fs.unlinkSync(adjPath); } catch(e) {}
                                            if (ttsRetries < 0) {
                                                console.warn(`❌ Grupo ${group.index} agotó reintentos, insertando silencio`);
                                                await generateSilence(adjPath, Math.max(0.01, groupDuration));
                                            } else {
                                                await new Promise(r => setTimeout(r, 2000 * (2 - ttsRetries)));
                                            }
                                        }
                                    }
                                } else {
                                    await generateSilence(adjPath, Math.max(0.01, groupDuration));
                                }
                            })());
                        }

                        await Promise.all(batchPromises);
                        const currentDone = groups.slice(0, bEnd).filter((_, idx) => {
                            const ap = path.join(segDir, `adj_g${idx}.wav`);
                            return fs.existsSync(ap) && fs.statSync(ap).size > 100;
                        }).length;
                        sendStatus(`Audio grupo ${currentDone}/${groups.length} para ${langNames[lang]}...`, progress + (progressStep * 0.8 * (currentDone / groups.length)));
                    }

                    // Construir timeline con silencios en los gaps entre grupos
                    const timeline = [];

                    // Silencio inicial si el primer grupo no empieza en 0
                    if (groups[0].start > 0.05) {
                        const silPath = path.join(segDir, 'pre_silence.wav');
                        if (!fs.existsSync(silPath)) await generateSilence(silPath, groups[0].start);
                        timeline.push(silPath);
                    }

                    for (let i = 0; i < groups.length; i++) {
                        timeline.push(path.join(segDir, `adj_g${i}.wav`));

                        // Silencio entre este grupo y el siguiente
                        if (i < groups.length - 1) {
                            const gap = groups[i + 1].start - groups[i].end;
                            if (gap > 0.05 && gap < 30) {
                                const gapPath = path.join(segDir, `gap_g${i}.wav`);
                                if (!fs.existsSync(gapPath)) await generateSilence(gapPath, gap);
                                timeline.push(gapPath);
                            } else if (gap > 30) {
                                console.warn(`⚠️ Gap grupo ${i} absurdly large (${gap.toFixed(2)}s), capping to 1s`);
                                const gapPath = path.join(segDir, `gap_g${i}.wav`);
                                if (!fs.existsSync(gapPath)) await generateSilence(gapPath, 1.0);
                                timeline.push(gapPath);
                            }
                        }
                    }

                    // No end_pad needed: end screen zone segments are already filtered out,
                    // and the final mix's apad+atrim pads with silence to videoDuration

                    // Concatenar todo usando rutas absolutas
                    const listPath = path.join(segDir, 'concat.txt');
                    fs.writeFileSync(listPath, timeline.map(f => `file '${f.replace(/\\/g, '/')}'`).join('\n'));
                    await new Promise((resolve, reject) => {
                        const p = spawn('ffmpeg', ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-ar', '24000', '-ac', '1', '-acodec', 'pcm_s16le', segAudioOutputPath]);
                        let stderr = '';
                        p.stderr.on('data', d => stderr += d);
                        p.on('close', c => {
                            try { fs.unlinkSync(listPath); } catch(e) {}
                            c === 0 ? resolve() : reject(new Error(`Segment concat failed: ${stderr.slice(-200)}`));
                        });
                    });

                    sendStatus(`Audio segment-based listo para ${langNames[lang]}`, progress + (progressStep * 0.9));
                }
            } else if (fs.existsSync(langScriptPath)) {
                translatedText = fs.readFileSync(langScriptPath, 'utf8');
            } else {
                const detectedLang = transcriptionResult.language || null;
                if (detectedLang && detectedLang === lang) {
                    console.log(`🔄 Idioma detectado (${detectedLang}) coincide con target (${lang}), usando texto original`);
                    translatedText = originalText;
                    fs.writeFileSync(langScriptPath, translatedText);
                } else {
                let specialInstruction = "";
                if (['de', 'ko', 'ru'].includes(lang)) {
                    specialInstruction = `
                    IMPORTANT DURATION CONTROL:
                    1. Randomly select approximately 30% of paragraphs.
                    2. For these selected paragraphs ONLY, condense translation by about 20%.
                    3. Translate remaining paragraphs faithfully.
                    `;
                }
                if (req.body.podcastStyle === 'true') {
                    specialInstruction += `
                    STYLE AND TONE: Conversational and casual, but informative.
                    Include natural speech elements and fillers.
                    Make it sound like a REAL PODCAST TRANSCRIPT.
                    Keep the total word count similar to the original.
                    `;
                }

                const prompt = `Translate the following video script content to ${langNames[lang]}.
${specialInstruction}
Maintain the tone, style, and formatting.
OUTPUT ONLY THE TRANSLATED TEXT.

SCRIPT:
${originalText}`;

                let result;
                let usedModel = req.body.translationModel || GEMINI_TEXT_MODEL;
                let usedKeyType = 'free';
                try {
                    const selectedModel = req.body.translationModel || GEMINI_TEXT_MODEL;
                    const aiResult = await getGoogleAI(selectedModel, { context: 'llm', clientKeys });
                    usedKeyType = aiResult.keyType;
                    result = await aiResult.model.generateContent(prompt);
                } catch (error) {
                    const isRateLimit = error.message.includes('429') || (error.status === 429);
                    const isOverloaded = error.message.includes('503') || (error.status === 503);
                    if (isRateLimit || isOverloaded) {
                        const selectedModel = req.body.translationModel || GEMINI_TEXT_MODEL;
                        try {
                            const aiResult = await getGoogleAI(selectedModel, { context: 'llm', forcePrimary: true, clientKeys });
                            usedKeyType = 'primary';
                            result = await aiResult.model.generateContent(prompt);
                        } catch (primaryError) {
                            if ((primaryError.status === 503) && selectedModel === GEMINI_TEXT_MODEL) {
                                usedModel = "gemini-3.1-flash-lite-preview";
                                const aiResult = await getGoogleAI(usedModel, { context: 'llm', forcePrimary: true, clientKeys });
                                usedKeyType = 'primary';
                                result = await aiResult.model.generateContent(prompt);
                            } else throw primaryError;
                        }
                    } else throw error;
                }

                // Track cost if PRINCIPAL
                if (usedKeyType === 'primary') {
                    const usage = result.response.usageMetadata;
                    if (usage) trackCost(costTracker, usedModel, usage.promptTokenCount, usage.candidatesTokenCount);
                }

                translatedText = result.response.text();
                translatedText = translatedText.replace(/```[\s\S]*?```/g, '').trim();
                if (!translatedText) translatedText = result.response.text();
                fs.writeFileSync(langScriptPath, translatedText);
                }
            }

            // TTS
            const ttsProvider = req.body.ttsProvider || 'google';
            const googleVoice = req.body.googleVoice || 'Kore';

            if (ttsProvider === 'text_only') {
                progress += progressStep;
                sendStatus(`Texto traducido para ${langNames[lang]} guardado.`, progress);
                continue;
            }

            const audioOutputPath = path.join(outputDir, `audio_${lang}.wav`);

            if (!fs.existsSync(audioOutputPath)) {
                sendStatus(`Generando audio para ${langNames[lang]}...`, progress + (progressStep / 2));

                if (!translatedText || translatedText === 'undefined') throw new Error(`Texto vacío para ${langNames[lang]}`);
                try {
                    if (ttsProvider === 'google_cloud' || ttsProvider === 'google_wavenet') {
                        const cloudVoice = req.body.cloudVoice || 'male';
                        const voiceType = ttsProvider === 'google_wavenet' ? 'wavenet' : 'neural2';
                        const cloudResult = await generateSingleCloudTTS(translatedText, audioOutputPath, lang, cloudVoice, voiceType, clientKeys);
                        if (cloudResult?.isPrimary) trackCloudTTSCost(costTracker, cloudResult.model, cloudResult.characters);
                    } else {
                        const isPro = ttsProvider === 'google_pro';
                        const ttsModelName = isPro ? GEMINI_TTS_MODEL_PRO : GEMINI_TTS_MODEL_FLASH;
                        const randomVoice = req.body.randomVoice === 'true';
                        await generateGoogleTTSWithSplitting(translatedText, audioOutputPath, lang, googleVoice, ttsModelName, randomVoice, false, false, '', clientKeys);
                    }
                } catch (err) {
                    const isRateLimit = err.message.includes('429') || (err.status === 429) || err.message.includes('RESOURCE_EXHAUSTED');
                    if (isRateLimit) {
                        sendStatus(`⚠️ Cuota agotada para ${langNames[lang]}.`, progress, false, "RATE_LIMIT_EXCEEDED");
                        throw new Error(`RATE_LIMIT_EXCEEDED para ${langNames[lang]}`);
                    }
                    throw err;
                }
            }

            // Duration adjust
            const segmentBased = transcriptionResult.segments && transcriptionResult.segments.length > 0;
            let filterString = `apad,atrim=0:${videoDuration}`;

            if (!segmentBased) {
                let ttsDuration = 0;
                try {
                    await new Promise((resolve) => {
                        const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', audioOutputPath]);
                        let output = '';
                        ffprobe.stdout.on('data', (data) => output += data.toString());
                        ffprobe.on('close', (code) => { if (code === 0) ttsDuration = parseFloat(output); resolve(); });
                    });
                } catch (e) {}

                if (ttsDuration > 0) {
                    const targetSpeechDuration = Math.max(1.0, videoDuration - endScreenSeconds);
                    const speedFactor = ttsDuration / targetSpeechDuration;
                    let filters = [];
                    let currentSpeed = speedFactor;
                    while (currentSpeed > 2.0) { filters.push('atempo=2.0'); currentSpeed /= 2.0; }
                    while (currentSpeed < 0.5) { filters.push('atempo=0.5'); currentSpeed /= 0.5; }
                    filters.push(`atempo=${currentSpeed}`);
                    filterString = filters.join(',') + `,apad,atrim=0:${videoDuration}`;
                }
            }

            // Final mix
            console.log(`🎬 Final mix: segmentBased=${segmentBased}, videoDuration=${videoDuration}, filterString=${filterString}`);
            await new Promise((resolve, reject) => {
                let ffmpegArgs = [];

                if (musicFile) {
                    ffmpegArgs = ['-y', '-i', audioOutputPath, '-stream_loop', '-1', '-i', musicFile.path,
                        '-filter_complex', `[0:a]aresample=48000,${filterString}[speech];[1:a]aresample=48000,volume=0.7[bgm];[speech][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[out]`,
                        '-map', '[out]', '-acodec', 'pcm_s16le', finalAudioPath];
                } else {
                    ffmpegArgs = ['-y', '-i', audioOutputPath, '-af', `aresample=48000,${filterString}`, '-acodec', 'pcm_s16le', finalAudioPath];
                }

                const ffmpegCmd = spawn('ffmpeg', ffmpegArgs);
                let stderr = '';
                ffmpegCmd.stderr.on('data', (data) => { stderr += data.toString(); });
                ffmpegCmd.on('close', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error(`FFmpeg error: ${stderr.slice(-200)}`));
                });
            });

            progress += progressStep;
        }

        // Send cost summary and save cost report
        const costSummary = calculateCostSummary(costTracker);
        if (costSummary && costSummary.totalCost > 0) {
            const costData = JSON.stringify({
                costSummary: {
                    totalCost: costSummary.totalCost,
                    byModel: costSummary.byModel
                }
            });
            res.write(`data: ${costData}\n\n`);

            // Save cost report .txt
            try {
                const now = new Date();
                const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
                let report = `=== REPORTE DE COSTOS ===\n`;
                report += `Fecha: ${now.toLocaleString()}\n`;
                report += `Video: ${videoName}\n`;
                report += `Total: $${costSummary.totalCost.toFixed(6)} USD (~$${(costSummary.totalCost * MXN_RATE).toFixed(2)} MXN)\n`;
                report += `\n--- Desglose por modelo ---\n`;
                for (const [model, info] of Object.entries(costSummary.byModel)) {
                    const usd = info.cost.toFixed(6);
                    const mxn = (info.cost * MXN_RATE).toFixed(2);
                    if (info.characters > 0) {
                        report += `${model}: $${usd} USD (~$${mxn} MXN) — ${info.characters.toLocaleString()} caracteres\n`;
                    } else {
                        report += `${model}: $${usd} USD (~$${mxn} MXN) — ${info.input.toLocaleString()} input / ${info.output.toLocaleString()} output tokens\n`;
                    }
                }
                report += `\n--- Nota ---\n`;
                report += `Solo se contabilizan llamadas hechas con la API Key PRINCIPAL.\n`;
                report += `Las API keys gratuitas no generan costo.\n`;
                report += `Tipo de cambio usado: 1 USD = $${MXN_RATE} MXN (aproximado).\n`;
                fs.writeFileSync(path.join(outputDir, `costo_${dateStr}.txt`), report, 'utf8');
            } catch (e) {
                console.warn('⚠️ No se pudo guardar el reporte de costos:', e.message);
            }

            // Persist to global costs history
            saveCostEntry(videoName, costSummary, languages);
        }

        sendStatus('Proceso completado', 100, true);
        res.end();

    } catch (error) {
        console.error(error);
        sendStatus('Error: ' + error.message, null, false, error.message);
        res.end();
    }
});

// ==============================
// TRADUCCIÓN MANUAL DE VIDEO
// ==============================

const manualUploadFields = [
    { name: 'video', maxCount: 1 },
    { name: 'music', maxCount: 1 },
    ...['es', 'en', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ko', 'ja'].map(lang => ({ name: `audio_${lang}`, maxCount: 1 }))
];

app.post('/api/manual-translate-video', upload.fields(manualUploadFields), async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const sendStatus = (status, progress = null, completed = false, error = null) => {
        const data = JSON.stringify({ status, progress, completed, error });
        res.write(`data: ${data}\n\n`);
    };

    try {
        if (!req.files || !req.files['video']) throw new Error('No se ha subido el archivo de video.');

        const videoFile = req.files['video'][0];
        const videoPath = videoFile.path;
        const videoName = path.parse(videoFile.originalname).name;
        const musicFile = req.files['music'] ? req.files['music'][0] : null;

        const outputDir = path.join(globalOutputDir, videoName);
        if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

        try { fs.copyFileSync(videoPath, path.join(outputDir, `original_video${path.extname(videoPath)}`)); } catch (e) {}

        sendStatus('Analizando duración del video...', 10);

        let videoDuration = 0;
        await new Promise((resolve, reject) => {
            const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath]);
            let output = '';
            ffprobe.stdout.on('data', (data) => output += data.toString());
            ffprobe.on('close', (code) => {
                if (code === 0) { videoDuration = parseFloat(output); resolve(); }
                else reject(new Error('Error al analizar duración del video'));
            });
        });

        const langs = ['es', 'en', 'fr', 'de', 'it', 'pt', 'ru', 'zh', 'ko', 'ja'];
        const foundLangs = langs.filter(lang => req.files[`audio_${lang}`]);
        if (foundLangs.length === 0) throw new Error('No se encontraron archivos de audio.');

        sendStatus(`Encontrados audios para: ${foundLangs.join(', ')}`, 20);

        const progressStep = 80 / foundLangs.length;
        let currentProgress = 20;

        const langNames = {
            'es': 'Spanish', 'en': 'English', 'fr': 'French', 'de': 'German', 'it': 'Italian',
            'pt': 'Portuguese', 'ru': 'Russian', 'zh': 'Chinese', 'ko': 'Korean', 'ja': 'Japanese'
        };

        for (const lang of foundLangs) {
            const langAudioFile = req.files[`audio_${lang}`][0];
            const langAudioPath = langAudioFile.path;
            const finalName = langNames[lang] || lang;
            const finalOutputPath = path.join(outputDir, `${finalName}.wav`);

            sendStatus(`Procesando audio: ${finalName}...`, currentProgress);

            let audioDuration = 0;
            await new Promise((resolve) => {
                const ffprobe = spawn('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', langAudioPath]);
                let output = '';
                ffprobe.stdout.on('data', (d) => output += d);
                ffprobe.on('close', () => { audioDuration = parseFloat(output) || 0; resolve(); });
            });

            let filterString = `apad,atrim=0:${videoDuration}`;
            if (audioDuration > 0) {
                const manualEndScreen = Math.max(0, parseInt(req.body.endScreenSeconds) || 0);
                const targetSpeechDuration = Math.max(1.0, videoDuration - manualEndScreen);
                const speedFactor = audioDuration / targetSpeechDuration;
                let filters = [];
                let currentSpeed = speedFactor;
                while (currentSpeed > 2.0) { filters.push('atempo=2.0'); currentSpeed /= 2.0; }
                while (currentSpeed < 0.5) { filters.push('atempo=0.5'); currentSpeed /= 0.5; }
                filters.push(`atempo=${currentSpeed}`);
                filterString = filters.join(',') + `,apad,atrim=0:${videoDuration}`;
            }

            await new Promise((resolve, reject) => {
                let ffmpegArgs;
                if (musicFile) {
                    ffmpegArgs = ['-y', '-i', langAudioPath, '-stream_loop', '-1', '-i', musicFile.path,
                        '-filter_complex', `[0:a]aresample=48000,${filterString}[speech];[1:a]aresample=48000,volume=0.7[bgm];[speech][bgm]amix=inputs=2:duration=first:dropout_transition=2:normalize=0[out]`,
                        '-map', '[out]', '-acodec', 'pcm_s16le', finalOutputPath];
                } else {
                    ffmpegArgs = ['-y', '-i', langAudioPath, '-af', `aresample=48000,${filterString}`, '-acodec', 'pcm_s16le', finalOutputPath];
                }

                const ffmpeg = spawn('ffmpeg', ffmpegArgs);
                let errLog = '';
                ffmpeg.stderr.on('data', d => errLog += d);
                ffmpeg.on('close', code => {
                    if (code === 0) resolve();
                    else reject(new Error(`Error mezclando audio ${lang}: ${errLog.slice(-200)}`));
                });
            });

            currentProgress += progressStep;
        }

        sendStatus('Proceso completado', 100, true);
        res.end();

    } catch (error) {
        console.error("Manual Translate Error:", error);
        sendStatus('Error: ' + error.message, null, false, error.message);
        res.end();
    }
});

// ==============================
// INICIO DEL SERVIDOR
// ==============================

process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
    console.error('❌ Uncaught Exception:', error);
});

app.listen(PORT, () => {
    console.log(`\n🌐 Traductor de Video IA corriendo en http://localhost:${PORT}`);
    console.log(`📁 Directorio de outputs: ${globalOutputDir}`);
    console.log(`🤖 Modelo de texto: ${GEMINI_TEXT_MODEL}`);
    console.log(`🔊 TTS Flash: ${GEMINI_TTS_MODEL_FLASH}`);
    console.log(`🔊 TTS Pro: ${GEMINI_TTS_MODEL_PRO}\n`);
});
