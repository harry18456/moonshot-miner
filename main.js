const { app, BrowserWindow, Tray, Menu, ipcMain, screen, Notification } = require('electron');
const path = require('path');
const { Worker } = require('worker_threads');
require('dotenv').config();

app.name = 'MoonshotMiner';
// Often fixes cache lock issues on dev builds
app.commandLine.appendSwitch('disable-gpu-shader-disk-cache');
app.commandLine.appendSwitch('disable-http-cache');


let store;

// Default Config
const DEFAULT_CONFIG = {
    walletAddress: process.env.WALLET_ADDRESS || '',
    intensity: 100 // sleep time in ms
};

let mainWindow = null;
let tray = null;
let minerWorker = null;

// Set App User Model ID for Windows Notifications
app.setAppUserModelId('com.moonshot.miner');

let isQuitting = false;

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
            contextIsolation: true
        },
        show: false
    });

    mainWindow.loadFile('index.html');

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
    // Check if icon exists, otherwise handle gracefully or use default
    const iconPath = path.join(__dirname, 'icon.png');
    tray = new Tray(iconPath);

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

    const config = store.get('config');
    if (!config.walletAddress) {
        mainWindow.webContents.send('status-update', { state: 'ERROR', message: 'No Wallet Address' });
        return;
    }

    minerWorker = new Worker(path.join(__dirname, 'miner.worker.js'), {
        workerData: config
    });

    minerWorker.on('message', (msg) => {
        if (msg.type === 'hashrate') {
            // Update tooltip with hashrate if we are mining
            if (tray && !tray.isDestroyed()) {
                tray.setToolTip(`Moonshot Miner: MINING (${msg.payload})`);
            }
        } else {
            console.log('Worker Message:', msg);
            // Forward msg to Renderer
            if (mainWindow) {
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

                    // Send explicit status update for UI state logic
                    mainWindow.webContents.send('status-update', { state: state });
                } else if (msg.type === 'error') {
                    if (tray && !tray.isDestroyed()) tray.setToolTip(`Moonshot Miner: ERROR`);
                    mainWindow.webContents.send('status-update', { state: 'ERROR', message: msg.payload });
                } else if (msg.type === 'share') {
                    if (tray && !tray.isDestroyed()) tray.setToolTip(`Moonshot Miner: SUBMITTED`);
                    mainWindow.webContents.send('status-update', { state: 'SHARE', message: msg.payload });

                    new Notification({
                        title: 'Moonshot Miner',
                        body: `🎉 ${msg.payload}`,
                        icon: path.join(__dirname, 'icon.png')
                    }).show();
                }
            }
        }

        // Still forward raw message for other uses (hashrate)
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('worker-message', msg);
        }
    });

    minerWorker.on('error', (err) => {
        console.error('Worker error:', err);
        if (mainWindow) {
            mainWindow.webContents.send('status-update', { state: 'ERROR', message: err.message });
        }
        stopMiner();
    });

    minerWorker.on('exit', (code) => {
        if (code !== 0) {
            console.error(`Worker stopped with exit code ${code}`);
        }
        minerWorker = null;
        if (mainWindow) mainWindow.webContents.send('status-update', { state: 'IDLE' });
    });

    if (mainWindow) mainWindow.webContents.send('status-update', { state: 'CONNECTING' });
}

function stopMiner() {
    if (minerWorker) {
        minerWorker.terminate();
        minerWorker = null;
    }
    if (mainWindow) mainWindow.webContents.send('status-update', { state: 'IDLE' });
}

function updateConfig(newConfig) {
    console.log('Update Config called with:', newConfig);
    store.set('config', newConfig);
    console.log('Store updated. New config in store:', store.get('config'));

    // Broadcast new config to all windows if needed
    if (mainWindow) {
        // Optional: send back to confirm
    }

    // Apply Startup Setting
    // Note: This mainly works when the app is packaged as an EXE.
    // In dev mode it might try to launch Electron itself.
    app.setLoginItemSettings({
        openAtLogin: !!newConfig.openAtLogin,
        path: app.getPath('exe')
    });

    // If running, restart or update worker? For simplicity, restart if running.
    if (minerWorker) {
        stopMiner();
        startMiner(); // specific restart logic might be better but simple is OK for now
    }
}

// --- App Lifecycle ---

app.whenReady().then(async () => {
    const { default: Store } = await import('electron-store');
    store = new Store();

    // Initialize config if not exists
    if (!store.get('config')) {
        store.set('config', DEFAULT_CONFIG);
    }

    // Load configs and send to UI when ready - Register BEFORE window load to avoid race condition
    ipcMain.handle('get-config', () => store.get('config'));

    ipcMain.handle('save-config', (event, config) => {
        updateConfig(config);
        return true;
    });

    ipcMain.handle('start-miner', startMiner);
    ipcMain.handle('stop-miner', stopMiner);
    ipcMain.handle('get-app-version', () => app.getVersion());

    ipcMain.on('resize-me', (event, { width, height }) => {
        if (mainWindow) {
            mainWindow.setContentSize(width, height);
        }
    });

    createMainWindow();
    createTray();
});

app.on('window-all-closed', () => {
    // On Windows, we typically don't quit until user says so via Tray, 
    // but if the window is closed (destroyed) we might want to recreate it or just hide it.
    // In our case we prevent destruction usually or just hide.
    if (process.platform !== 'darwin') {
        // app.quit(); // Don't quit, keep tray alive
    }
});
