const { app, BrowserWindow, dialog, shell } = require('electron');
const path = require('path');
const net = require('net');

// ── Config ──
const PORT = 3001;
let mainWindow = null;

// ── FFmpeg path setup ──
function getResourcePath(...segments) {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, ...segments);
    }
    return path.join(__dirname, ...segments);
}

function setupFfmpegPath() {
    const ffmpegDir = getResourcePath('ffmpeg');
    process.env.PATH = ffmpegDir + path.delimiter + process.env.PATH;
}

// ── Port check ──
function isPortFree(port) {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(false));
        server.once('listening', () => { server.close(); resolve(true); });
        server.listen(port, '127.0.0.1');
    });
}

// ── Start Express server (in-process via dynamic import) ──
async function startServer() {
    const free = await isPortFree(PORT);
    if (!free) {
        console.log(`Puerto ${PORT} ya en uso — asumiendo que el servidor ya corre`);
        return;
    }

    process.env.PORT = String(PORT);

    // Dynamic import of the ESM server module — runs in the same Electron process
    const serverPath = 'file:///' + path.join(__dirname, 'index.js').replace(/\\/g, '/');
    await import(serverPath);
}

// ── Create window ──
function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 1000,
        minHeight: 700,
        title: 'Traductor de Video IA',
        backgroundColor: '#09090b',
        webPreferences: {
            nodeIntegration: false,
            contextIsolation: true,
        },
        autoHideMenuBar: true,
        show: false,
    });

    mainWindow.loadURL(`http://localhost:${PORT}`);

    mainWindow.once('ready-to-show', () => {
        mainWindow.show();
    });

    // Allow Firebase auth popups to open inside Electron
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        if (url.includes('accounts.google.com') || url.includes('firebaseapp.com') || url.includes('googleapis.com')) {
            return { action: 'allow' };
        }
        if (url.startsWith('http')) shell.openExternal(url);
        return { action: 'deny' };
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

// ── App lifecycle ──
app.whenReady().then(async () => {
    setupFfmpegPath();

    try {
        await startServer();
    } catch (err) {
        console.error('Error starting server:', err);
        dialog.showErrorBox('Error', 'No se pudo iniciar el servidor: ' + err.message);
        app.quit();
        return;
    }

    createWindow();
});

app.on('window-all-closed', () => {
    app.quit();
});
