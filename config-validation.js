// Pure config validation/sanitization for the save-config IPC boundary.
// Kept separate from main.js so it can be unit-tested without Electron.

// Plausibility check (NOT a checksum): mainnet Base58 (P2PKH/P2SH) or Bech32/
// Bech32m (segwit/taproot). Catches gibberish / wrong-charset / wrong-length
// typos so we can surface a clear local error; the pool still does the
// authoritative validation.
const BTC_ADDRESS_RE = /^([13][a-km-zA-HJ-NP-Z1-9]{25,34}|bc1[a-z0-9]{8,87})$/;

function isPlausibleBtcAddress(addr) {
    return typeof addr === 'string' && BTC_ADDRESS_RE.test(addr);
}

// Coerce intensity to an integer in the documented [0, 1000] range; non-numeric
// falls back to the default 100.
function clampIntensity(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return 100;
    return Math.min(1000, Math.max(0, Math.round(n)));
}

// Whitelist + coerce the raw IPC payload into a known-good config shape so
// unknown keys / wrong types never reach electron-store or the worker.
function sanitizeConfig(raw) {
    const cfg = (raw && typeof raw === 'object') ? raw : {};
    return {
        walletAddress: typeof cfg.walletAddress === 'string' ? cfg.walletAddress.trim() : '',
        intensity: clampIntensity(cfg.intensity),
        minimalMode: !!cfg.minimalMode,
        autoStart: !!cfg.autoStart,
        openAtLogin: !!cfg.openAtLogin,
    };
}

module.exports = { isPlausibleBtcAddress, clampIntensity, sanitizeConfig, BTC_ADDRESS_RE };
