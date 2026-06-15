const assert = require('assert');
const { isPlausibleBtcAddress, clampIntensity, sanitizeConfig } = require('../config-validation');

module.exports = function run() {
    // Valid mainnet addresses (plausibility, not checksum).
    assert.ok(isPlausibleBtcAddress('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'), 'P2PKH (genesis)');
    assert.ok(isPlausibleBtcAddress('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'), 'P2SH');
    assert.ok(isPlausibleBtcAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'), 'bech32 P2WPKH');

    // Invalid.
    assert.ok(!isPlausibleBtcAddress(''), 'empty');
    assert.ok(!isPlausibleBtcAddress('not an address'), 'has spaces');
    assert.ok(!isPlausibleBtcAddress('0xAbC123'), 'eth-like');
    assert.ok(!isPlausibleBtcAddress('1short'), 'too short');
    assert.ok(!isPlausibleBtcAddress(null), 'null');
    assert.ok(!isPlausibleBtcAddress(12345), 'number');

    // clampIntensity.
    assert.strictEqual(clampIntensity(100), 100);
    assert.strictEqual(clampIntensity(0), 0);
    assert.strictEqual(clampIntensity(-5), 0, 'negative -> 0');
    assert.strictEqual(clampIntensity(99999), 1000, 'over-range -> 1000');
    assert.strictEqual(clampIntensity(NaN), 100, 'NaN -> default 100');
    assert.strictEqual(clampIntensity('abc'), 100, 'non-numeric -> default 100');
    assert.strictEqual(clampIntensity('250'), 250, 'numeric string');
    assert.strictEqual(clampIntensity(12.7), 13, 'rounds');

    // sanitizeConfig whitelists keys and coerces types.
    const out = sanitizeConfig({
        walletAddress: '  bc1qxyz  ',
        intensity: '50',
        minimalMode: 1,
        evil: 'dropme',
        autoStart: undefined,
        openAtLogin: 'yes',
    });
    assert.deepStrictEqual(out, {
        walletAddress: 'bc1qxyz',
        intensity: 50,
        minimalMode: true,
        autoStart: false,
        openAtLogin: true,
    });
    assert.ok(!('evil' in out), 'unknown keys dropped');

    // Non-object input -> safe defaults.
    assert.deepStrictEqual(sanitizeConfig(null), {
        walletAddress: '',
        intensity: 100,
        minimalMode: false,
        autoStart: false,
        openAtLogin: false,
    });

    console.log('  config-validation: address + intensity clamp + sanitize whitelist passed');
};
