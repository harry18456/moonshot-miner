const { app, BrowserWindow, Tray, Menu, ipcMain, screen, Notification, nativeImage, session, dialog } = require('electron');
const path = require('path');
const { Worker } = require('worker_threads');
const { sanitizeConfig, isPlausibleBtcAddress } = require('./config-validation');
require('dotenv').config();

app.name = 'MoonshotMiner';
// Often fixes cache lock issues on dev builds
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');

// Set App User Model ID for Windows Notifications
app.setAppUserModelId('com.moonshot.miner');

// Last-resort safety net: surface unexpected throws/rejections instead of the
// process dying with output only on a console the packaged user never sees.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

let store;

// Default Config (full shape so a persisted config never has missing fields).
const DEFAULT_CONFIG = {
    walletAddress: process.env.WALLET_ADDRESS || '',
    intensity: 100, // sleep time in ms
    minimalMode: false,
    autoStart: false,
    openAtLogin: false
};

let mainWindow = null;
let tray = null;
let minerWorker = null;
let isQuitting = false;

function sendToRenderer(channel, payload) {
    if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send(channel, payload);
    }
}

// Minimal in-memory fallback if electron-store fails to initialize (corrupt or
// locked config.json) so the app still launches with defaults.
function createMemoryStore(initial) {
    const data = { ...initial };
    return {
        get: (key) => data[key],
        set: (key, value) => { data[key] = value; }
    };
}

function createMainWindow() {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;

    mainWindow = new BrowserWindow({
        width: 350,
        height: 250,
        x: width - 370,
        y: height - 270,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        resizable: true,
        webPreferences: {
            preload: path.join(__dirname, 'preload.js'),
            nodeIntegration: false,
            contextIsolation: true,
            sandbox: true
        },
        show: false
    });

    mainWindow.loadFile('index.html');

    // Lock the renderer to the local app: never navigate away or open popups.
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (url !== mainWindow.webContents.getURL()) {
            event.preventDefault();
        }
    });

    mainWindow.on('close', (event) => {
        if (!isQuitting) {
            event.preventDefault();
            mainWindow.hide();
            return false;
        }
    });

    mainWindow.on('closed', () => {
        mainWindow = null;
    });
}

function createTray() {
    const iconPath = path.join(__dirname, 'icon.png');

    // Load the icon defensively: new Tray() throws on a missing/unreadable icon
    // (AV lock, partial install), which would otherwise abort startup with no UI.
    let trayImage;
    try {
        trayImage = nativeImage.createFromPath(iconPath);
        if (trayImage.isEmpty()) {
            trayImage = nativeImage.createEmpty();
        }
    } catch (err) {
        console.error('Failed to load tray icon:', err);
        trayImage = nativeImage.createEmpty();
    }

    try {
        tray = new Tray(trayImage);
    } catch (err) {
        console.error('Failed to create tray, falling back to window:', err);
        // Degrade gracefully: at least show the window so the app is usable.
        if (!mainWindow) createMainWindow();
        if (mainWindow) mainWindow.show();
        return;
    }

    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show/Hide Status',
            click: () => toggleWindow()
        },
        { type: 'separator' },
        {
            label: 'Quit Moonshot',
            click: () => {
                isQuitting = true;
                stopMiner();
                app.quit();
            }
        }
    ]);

    tray.setToolTip('Moonshot Miner');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
        toggleWindow();
    });
}

function toggleWindow() {
    if (!mainWindow) {
        createMainWindow();
        mainWindow.show();
        return;
    }

    if (mainWindow.isVisible()) {
        mainWindow.hide();
    } else {
        mainWindow.show();
    }
}

// --- Worker Management ---

function startMiner() {
    if (minerWorker) return; // Already running

    const config = store.get('config') || {};
    if (!config.walletAddress) {
        sendToRenderer('status-update', { state: 'ERROR', message: 'No Wallet Address' });
        return;
    }
    if (!isPlausibleBtcAddress(config.walletAddress)) {
        sendToRenderer('status-update', { state: 'ERROR', message: 'Invalid BTC wallet address' });
        return;
    }

    let worker;
    try {
        worker = new Worker(path.join(__dirname, 'miner.worker.js'), {
            workerData: config
        });
    } catch (err) {
        console.error('Failed to spawn worker:', err);
        sendToRenderer('status-update', { state: 'ERROR', message: `Failed to start miner: ${err.message}` });
        return;
    }
    minerWorker = worker;

    worker.on('message', (msg) => {
        // Ignore messages from a worker that has been superseded (restart race).
        if (minerWorker !== worker) return;

        if (msg.type === 'hashrate') {
            // Update tooltip with hashrate if we are mining
            if (tray && !tray.isDestroyed()) {
                tray.setToolTip(`Moonshot Miner: MINING (${msg.payload})`);
            }
        } else {
            // Forward msg to Renderer
            if (msg.type === 'status') {
                // If the payload contains "Running" or "Authorized", we consider it MINING state
                let state = 'CONNECTING';
                if (msg.payload.includes('Running') || msg.payload.includes('Authorized')) {
                    state = 'MINING';
                } else if (msg.payload.includes('Connected')) {
                    state = 'CONNECTING';
                }

                // Update Tray Tooltip
                if (tray && !tray.isDestroyed()) {
                    tray.setToolTip(`Moonshot Miner: ${state}`);
                }

                sendToRenderer('status-update', { state: state });
            } else if (msg.type === 'error') {
                if (tray && !tray.isDestroyed()) tray.setToolTip(`Moonshot Miner: ERROR`);
                sendToRenderer('status-update', { state: 'ERROR', message: msg.payload });
            } else if (msg.type === 'share') {
                if (tray && !tray.isDestroyed()) tray.setToolTip(`Moonshot Miner: SUBMITTED`);
                sendToRenderer('status-update', { state: 'SHARE', message: msg.payload });

                new Notification({
                    title: 'Moonshot Miner',
                    body: `🎉 ${msg.payload}`,
                    icon: path.join(__dirname, 'icon.png')
                }).show();
            } else if (msg.type === 'share_rejected') {
                sendToRenderer('status-update', { state: 'ERROR', message: msg.payload });

                new Notification({
                    title: 'Moonshot Miner',
                    body: `⚠️ ${msg.payload}`,
                    icon: path.join(__dirname, 'icon.png')
                }).show();
            }
        }

        // Still forward raw message for other uses (hashrate)
        sendToRenderer('worker-message', msg);
    });

    worker.on('error', (err) => {
        if (minerWorker !== worker) return; // superseded worker
        console.error('Worker error:', err);
        sendToRenderer('status-update', { state: 'ERROR', message: err.message });
        stopMiner();
    });

    worker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Worker stopped with exit code ${code}`);
        }
        // Only react if this is still the active worker; otherwise a superseded
        // worker's late exit would null out the new worker and flip the UI to IDLE.
        if (minerWorker === worker) {
            minerWorker = null;
            sendToRenderer('status-update', { state: 'IDLE' });
        }
    });

    sendToRenderer('status-update', { state: 'CONNECTING' });
}

function stopMiner() {
    if (minerWorker) {
        const worker = minerWorker;
        // Detach first so the keyed exit handler won't re-send IDLE / null a
        // freshly-started worker during a restart.
        minerWorker = null;
        worker.terminate();
    }
    sendToRenderer('status-update', { state: 'IDLE' });
}

function updateConfig(rawConfig) {
    const newConfig = sanitizeConfig(rawConfig);
    store.set('config', newConfig);

    // Apply Startup Setting
    // Note: This mainly works when the app is packaged as an EXE.
    // In dev mode it might try to launch Electron itself.
    app.setLoginItemSettings({
        openAtLogin: !!newConfig.openAtLogin,
        path: app.getPath('exe')
    });

    // If running, restart so the worker picks up the new config. The keyed
    // exit handler makes the old worker's late exit a no-op.
    if (minerWorker) {
        stopMiner();
        startMiner();
    }
}

// --- App Lifecycle ---

function bootstrap() {
    app.whenReady().then(async () => {
        try {
            const { default: Store } = await import('electron-store');
            store = new Store();
        } catch (err) {
            console.error('Failed to initialize config store:', err);
            store = createMemoryStore({ config: { ...DEFAULT_CONFIG } });
            try {
                dialog.showErrorBox('Moonshot Miner', 'Could not load saved settings; running with defaults.');
            } catch (_) { /* dialog unavailable; continue */ }
        }

        // Initialize config if not exists
        if (!store.get('config')) {
            store.set('config', DEFAULT_CONFIG);
        }

        // Content-Security-Policy for the local renderer (defense-in-depth: the
        // renderer loads only local files and makes no network requests itself).
        try {
            session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
                callback({
                    responseHeaders: {
                        ...details.responseHeaders,
                        // script-src stays strict (the real XSS control). style-src
                        // allows 'unsafe-inline' because index.html uses inline style
                        // attributes; relaxing styles is not an injection vector here.
                        'Content-Security-Policy': [
                            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'"
                        ]
                    }
                });
            });
        } catch (err) {
            console.error('Failed to set CSP:', err);
        }

        // Register IPC handlers BEFORE window load to avoid a race condition.
        ipcMain.handle('get-config', () => store.get('config'));

        ipcMain.handle('save-config', (event, config) => {
            updateConfig(config);
            return true;
        });

        ipcMain.handle('start-miner', startMiner);
        ipcMain.handle('stop-miner', stopMiner);
        ipcMain.handle('get-app-version', () => app.getVersion());

        ipcMain.on('resize-me', (event, payload) => {
            const { width, height } = payload || {};
            const w = Math.round(Number(width));
            const h = Math.round(Number(height));
            if (mainWindow && Number.isFinite(w) && Number.isFinite(h)) {
                mainWindow.setContentSize(
                    Math.min(2000, Math.max(200, w)),
                    Math.min(2000, Math.max(100, h))
                );
            }
        });

        createMainWindow();
        createTray();
    }).catch((err) => {
        console.error('Startup failed:', err);
    });
}

app.on('window-all-closed', () => {
    // On Windows/Linux we keep the tray alive; do not quit on window close.
    if (process.platform !== 'darwin') {
        // app.quit(); // Intentionally left disabled to keep the tray running.
    }
});

// Single-instance lock: an "open at login" tray app must not spawn a second
// instance (second tray icon + second worker + duplicate pool connection).
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            mainWindow.show();
            mainWindow.focus();
        } else {
            toggleWindow();
        }
    });
    bootstrap();
}
