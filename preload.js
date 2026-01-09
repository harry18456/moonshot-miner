const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    getConfig: () => ipcRenderer.invoke('get-config'),
    saveConfig: (config) => ipcRenderer.invoke('save-config', config),
    startMiner: () => ipcRenderer.invoke('start-miner'),
    stopMiner: () => ipcRenderer.invoke('stop-miner'),
    resizeMe: (width, height) => ipcRenderer.send('resize-me', { width, height }),
    getAppVersion: () => ipcRenderer.invoke('get-app-version'),
    onWorkerMessage: (callback) => ipcRenderer.on('worker-message', (event, data) => callback(data)),
    onStatusUpdate: (callback) => ipcRenderer.on('status-update', (event, data) => callback(data))
});
