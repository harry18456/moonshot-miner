const walletInput = document.getElementById('wallet-address');
const intensityInput = document.getElementById('intensity');
const intensityVal = document.getElementById('intensity-val');
const toggleBtn = document.getElementById('toggle-mining-btn');
const settingsBtn = document.getElementById('settings-btn');
const settingsPanel = document.getElementById('settings-panel');
const saveBtn = document.getElementById('save-config-btn');
const statusText = document.getElementById('status-text');
const hashrateText = document.getElementById('hashrate');

let isMining = false;

// Initialize
const minimalCheckbox = document.getElementById('minimal-mode');
const autoStartCheckbox = document.getElementById('auto-start');
const openAtLoginCheckbox = document.getElementById('open-at-login');
const titleEl = document.querySelector('.title');
const statsEl = document.querySelector('.stats');

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
    try {
        const config = await window.api.getConfig();
        console.log('Renderer received config:', config);
        // FIXME: Remove this alert after debugging
        // alert('Debug: Config Loaded: ' + JSON.stringify(config)); 

        if (config) {
            if (walletInput) {
                walletInput.value = config.walletAddress || '';
                if (!walletInput.value) console.error('Wallet address empty in config!', config);
            } else {
                console.error('Wallet Input element not found!');
            }

            if (intensityInput) {
                intensityInput.value = config.intensity || 100;
                intensityVal.innerText = intensityInput.value;
            }

            // Load Minimal Mode
            if (config.minimalMode) {
                minimalCheckbox.checked = true;
                applyMinimalMode(true);
            }

            // Load Auto Start
            if (config.autoStart) {
                autoStartCheckbox.checked = true;
            }

            // Load Open At Login
            if (config.openAtLogin) {
                openAtLoginCheckbox.checked = true;
            }

            // Initial resize based on content
            updateWindowSize();

            // Load Version
            const version = await window.api.getAppVersion();
            const versionEl = document.getElementById('app-version');
            if (versionEl) versionEl.innerText = version;

            // Auto Execute if Configured
            if (config.walletAddress && config.autoStart) {
                console.log('Auto-starting miner...');
                window.api.startMiner();
            }
        }
    } catch (err) {
        console.error('Failed to load config', err);
        alert('Config Load Error: ' + err.message);
    }
});

// Settings Logic
settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.toggle('hidden');
    updateWindowSize();
});

intensityInput.addEventListener('input', (e) => {
    intensityVal.innerText = e.target.value;
});

saveBtn.addEventListener('click', () => {
    const newConfig = {
        walletAddress: walletInput.value.trim(),
        intensity: parseInt(intensityInput.value, 10),
        minimalMode: minimalCheckbox.checked,
        autoStart: autoStartCheckbox.checked,
        openAtLogin: openAtLoginCheckbox.checked
    };
    window.api.saveConfig(newConfig);

    // Apply immediate
    applyMinimalMode(minimalCheckbox.checked);

    settingsPanel.classList.add('hidden');
    updateWindowSize();
});

function applyMinimalMode(isMinimal) {
    if (isMinimal) {
        titleEl.style.display = 'none';
        statsEl.style.display = 'none';
    } else {
        titleEl.style.display = 'block';
        statsEl.style.display = 'flex';
    }
}

function updateWindowSize() {
    // Small delay to allow DOM to reflow/render (e.g. after class toggle)
    setTimeout(() => {
        const container = document.querySelector('.container');
        if (container) {
            const contentHeight = container.scrollHeight;
            // Add a small buffer for OS borders/shadows if needed, though frameless usually exact.
            // We add a little padding to be safe.
            // We use ceil to avoid fractional pixel cutoff.
            const targetHeight = Math.ceil(contentHeight);

            // call resize
            window.api.resizeMe(350, targetHeight);
        }
    }, 10);
}

// Mining Control
toggleBtn.addEventListener('click', () => {
    if (isMining) {
        window.api.stopMiner();
    } else {
        if (!walletInput.value) {
            alert('Please enter a BTC wallet address first!');
            settingsPanel.classList.remove('hidden');
            updateWindowSize();
            return;
        }
        window.api.startMiner();
    }
});

// Status Updates
window.api.onStatusUpdate((data) => {
    const { state, message } = data;

    statusText.innerText = state;
    statusText.className = 'status-indicator'; // reset

    if (state === 'MINING' || state === 'CONNECTING' || state === 'SHARE') {
        isMining = true;
        toggleBtn.innerText = 'Stop';
        toggleBtn.classList.add('active');

        if (state === 'MINING') statusText.classList.add('mining');
        if (state === 'CONNECTING') statusText.classList.add('connected');
    } else {
        isMining = false;
        toggleBtn.innerText = 'Start Mining';
        toggleBtn.classList.remove('active');
        if (state === 'ERROR') {
            statusText.classList.add('error');
            if (message) alert(message);
        }
    }

    if (state === 'SHARE') {
        // Show share notification without stopping mining UI
        statusText.innerText = 'SUBMITTED';
        statusText.style.color = '#ffd700'; // Gold
        setTimeout(() => {
            // Revert visually to mining if still mining
            if (isMining) {
                statusText.innerText = 'MINING';
                statusText.style.color = ''; // Reset to class style
                statusText.className = 'status-indicator mining';
            }
        }, 1500);

        // Optional: Maybe show a toast or log it
        console.log('Share result:', message);
    }
});

window.api.onWorkerMessage((msg) => {
    if (msg.type === 'hashrate') {
        hashrateText.innerText = `${msg.payload} H/s`;
    }
    // Also handle status from worker if needed
});
