// End-to-end smoke test for the restructured mine() (chunked sweep + snapshots
// + buildBlockHeader). Drives the REAL worker through subscribe -> authorize ->
// notify with mocked net/worker_threads and asserts a full nonce sweep runs,
// builds the header, and reports hashrate without throwing.
const assert = require('assert');
const path = require('path');
const Module = require('module');

module.exports = function run() {
    const sockets = [];
    const written = [];

    class FakeSocket {
        constructor() { this.handlers = {}; this.destroyed = false; sockets.push(this); }
        setEncoding() {}
        connect(port, host, cb) { this.connectCb = cb; }
        on(ev, h) { this.handlers[ev] = h; return this; }
        removeAllListeners() { this.handlers = {}; }
        destroy() { this.destroyed = true; }
        write(data) { written.push(data); return true; }
        emit(ev, ...a) { if (this.handlers[ev]) this.handlers[ev](...a); }
        feed(obj) { this.emit('data', JSON.stringify(obj) + '\n'); }
    }

    const messages = [];
    const fakeParentPort = { postMessage: (m) => messages.push(m) };

    // Capture setTimeout (so mine() does not auto-loop); keep setImmediate REAL so
    // the chunked sweep progresses. The test waits on the saved real timer.
    const realSetTimeout = global.setTimeout;
    global.setTimeout = () => ({ __captured: true });

    const realRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
        if (id === 'worker_threads') {
            return { parentPort: fakeParentPort, workerData: { walletAddress: 'bc1qtest', intensity: 100 } };
        }
        if (id === 'net') return { Socket: FakeSocket };
        return realRequire.apply(this, arguments);
    };

    const restore = () => {
        Module.prototype.require = realRequire;
        global.setTimeout = realSetTimeout;
    };

    try {
        const workerPath = path.join(__dirname, '..', 'miner.worker.js');
        delete require.cache[require.resolve(workerPath)];
        require(workerPath);

        const sock = sockets[0];
        sock.connectCb(); // TCP "connected" -> worker sends mining.subscribe
        sock.feed({ id: 1, result: [[['mining.set_difficulty', 'x']], 'abcd1234', 4] }); // -> sends authorize
        sock.feed({ id: 2, result: true }); // authorized
        sock.feed({
            method: 'mining.notify',
            params: [
                'job1',
                '00'.repeat(32), // prevHash (32 bytes)
                '01000000',      // coinb1
                '00000000',      // coinb2
                [],              // merkleBranch (coinbase-only)
                '20000000',      // version (4 bytes)
                '1d00ffff',      // nbits (4 bytes)
                '5e9e7c00',      // ntime (4 bytes)
                true,            // cleanJobs
            ],
        });
    } catch (e) {
        restore();
        throw e;
    }

    // Let the real setImmediate chunk-chain finish the 10000-hash sweep.
    return new Promise((resolve, reject) => {
        realSetTimeout(() => {
            try {
                const errors = messages.filter((m) => m.type === 'error');
                assert.ok(
                    !errors.some((e) => /Failed to build header/.test(e.payload)),
                    'no header-build error: ' + JSON.stringify(errors)
                );
                assert.ok(written.some((w) => w.includes('mining.subscribe')), 'subscribe was sent');
                assert.ok(written.some((w) => w.includes('mining.authorize')), 'authorize was sent');
                assert.ok(messages.some((m) => m.type === 'hashrate'), 'a full sweep completed and reported hashrate');
                console.log('  mining: subscribe->authorize->notify->sweep runs and reports hashrate (no crash)');
                resolve();
            } catch (e) {
                reject(e);
            } finally {
                restore();
            }
        }, 200);
    });
};
