// Run the real worker with deterministic scheduling and an in-memory Stratum
// transport. No global require/timer patches and no connection to a real wallet.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

module.exports = function createWorker({ intensity = 100, hash } = {}) {
    const sockets = [], messages = [], timers = [], immediates = [];
    class Socket {
        constructor() { this.handlers = {}; this.writes = []; sockets.push(this); }
        setEncoding() {}
        connect(port, host, callback) { this.host = host; this.connected = callback; }
        on(event, callback) { this.handlers[event] = callback; return this; }
        removeAllListeners() { this.handlers = {}; }
        destroy() { this.destroyed = true; }
        write(line) { this.writes.push(JSON.parse(line)); return true; }
        emit(event, ...args) { this.handlers[event]?.(...args); }
        feed(message) { this.emit('data', JSON.stringify(message) + '\n'); }
    }
    const helpers = require('../hash-utils');
    const context = {
        Buffer, console,
        Math: Object.assign(Object.create(Math), { random: () => 0 }),
        require(id) {
            if (id === 'worker_threads') return {
                workerData: { walletAddress: 'test.worker', intensity },
                parentPort: { postMessage: message => messages.push(message) },
            };
            if (id === 'net') return { Socket };
            if (id === './hash-utils') return hash ? { ...helpers, sha256d: hash } : helpers;
            throw new Error(`Unexpected worker dependency: ${id}`);
        },
        setTimeout(callback, delay) { const timer = { callback, delay }; timers.push(timer); return timer; },
        setImmediate(callback) { immediates.push(callback); },
    };
    vm.createContext(context);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '../miner.worker.js'), 'utf8'), context);
    return {
        sockets, messages, timers, immediates,
        // Seed the boundary without spending 2^32 hashes to reach it.
        setCursor: vm.runInContext('(nonce, en2) => { nextNonce = nonce; extraNonce2 = en2; }', context),
        subscribe(socket = sockets.at(-1)) {
            socket.connected();
            socket.feed({ id: 1, result: [[], 'abcd1234', 8], error: null });
            return socket;
        },
        drain() {
            let count = 0;
            while (immediates.length) {
                if (++count > 100) throw new Error('Mining loop did not yield to sleep');
                immediates.shift()();
            }
        },
        fireTimer(delay) {
            const index = timers.findIndex(timer => timer.delay === delay);
            if (index < 0) throw new Error(`No timer with delay ${delay}`);
            timers.splice(index, 1)[0].callback();
        },
    };
};

module.exports.job = (id = 'job1') => ({
    method: 'mining.notify',
    params: [id, '01234567'.repeat(8), '01000000', '00000000',
        ['12'.repeat(32), '34'.repeat(32)], '20000000', '1d00ffff', '5e9e7c00', true],
});
