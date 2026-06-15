// Behavioral test for the reconnect state machine (#1 fix). Loads the REAL
// miner.worker.js with mocked `net` + `worker_threads`, drives a failed-reconnect
// sequence, and asserts auto-reconnect keeps scheduling (no isReconnecting wedge).
const assert = require('assert');
const path = require('path');
const Module = require('module');

module.exports = function run() {
    const sockets = [];
    let connectAttempts = 0;

    class FakeSocket {
        constructor() { this.handlers = {}; this.destroyed = false; sockets.push(this); }
        setEncoding() {}
        // Stay "in progress": do NOT invoke the success callback, simulating a
        // TCP connect that errors/closes before it ever connects.
        connect() { connectAttempts++; }
        on(ev, h) { this.handlers[ev] = h; return this; }
        removeAllListeners() { this.handlers = {}; }
        destroy() { this.destroyed = true; }
        write() { return true; }
        emit(ev, ...args) { if (this.handlers[ev]) this.handlers[ev](...args); }
    }

    const fakeParentPort = { postMessage: () => {} };

    // Capture reconnect timers so we can fire them deterministically (no 5s wait).
    const realSetTimeout = global.setTimeout;
    const timers = [];
    global.setTimeout = (fn) => { timers.push(fn); return { __fakeTimer: true }; };
    const flushTimer = () => { const fn = timers.shift(); if (fn) fn(); };

    // Intercept ONLY the worker's require('worker_threads') and require('net').
    const realRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
        if (id === 'worker_threads') {
            return { parentPort: fakeParentPort, workerData: { walletAddress: 'bc1qtest', intensity: 100 } };
        }
        if (id === 'net') return { Socket: FakeSocket };
        return realRequire.apply(this, arguments);
    };

    try {
        const workerPath = path.join(__dirname, '..', 'miner.worker.js');
        delete require.cache[require.resolve(workerPath)];
        require(workerPath); // runs connect() once at module load -> attempt #1

        assert.strictEqual(connectAttempts, 1, 'initial connect on load');

        // Initial connection fails at the TCP layer (error then close, no success).
        sockets[0].emit('error', { message: 'ECONNREFUSED' });
        sockets[0].emit('close');
        assert.strictEqual(timers.length, 1, 'one reconnect timer after first failure');

        // Fire the reconnect -> attempt #2.
        flushTimer();
        assert.strictEqual(connectAttempts, 2, 'second connect attempt');

        // The RECONNECT also fails at the TCP layer — the exact wedge scenario.
        sockets[1].emit('error', { message: 'ECONNREFUSED' });
        sockets[1].emit('close');

        // With the fix (isReconnecting reset at the top of connect), a further
        // reconnect IS scheduled. With the bug, timers.length would be 0 here.
        assert.strictEqual(timers.length, 1, 'reconnect re-scheduled AFTER a failed reconnect (no wedge)');
        flushTimer();
        assert.strictEqual(connectAttempts, 3, 'third connect attempt — auto-reconnect survives repeated failures');
    } finally {
        Module.prototype.require = realRequire;
        global.setTimeout = realSetTimeout;
    }

    console.log('  reconnect: auto-reconnect survives repeated TCP-level failures (isReconnecting wedge fixed)');
};
