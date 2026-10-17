const assert = require('assert');
const crypto = require('crypto');
const createWorker = require('./worker-harness');
const { job } = createWorker;

const diff1 = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');
const digest = buffer => crypto.createHash('sha256').update(buffer).digest();
const hash256 = buffer => digest(digest(buffer));
const numericHash = buffer => BigInt('0x' + Buffer.from(buffer).reverse().toString('hex'));

// Pool-side reconstruction deliberately does not import the miner's serializers.
function poolHeader(notification, extraNonce2, nonce) {
    const p = notification.params;
    let root = hash256(Buffer.from(p[2] + 'abcd1234' + extraNonce2 + p[3], 'hex'));
    for (const branch of p[4]) root = hash256(Buffer.concat([root, Buffer.from(branch, 'hex')]));
    const header = Buffer.alloc(80);
    header.writeUInt32LE(parseInt(p[5], 16), 0);
    Buffer.from(p[1], 'hex').swap32().copy(header, 4);
    root.copy(header, 36);
    header.writeUInt32LE(parseInt(p[7], 16), 68);
    header.writeUInt32LE(parseInt(p[6], 16), 72);
    header.writeUInt32LE(nonce, 76);
    return header;
}

module.exports = function run() {
    const failures = [];
    function check(name, test) {
        try { test(); console.log(`  stratum: ${name}`); }
        catch (error) { failures.push(`${name}: ${error.message}`); }
    }

    check('zero intensity really schedules zero sleep', () => {
        const worker = createWorker({ intensity: 0, hash: () => Buffer.alloc(32, 0xff) });
        const socket = worker.subscribe();
        socket.feed({ id: 2, result: true });
        socket.feed(job());
        worker.drain();
        assert.strictEqual(worker.timers.at(-1).delay, 0);
    });

    check('difficulty changes apply to the next job, not the current sweep', () => {
        let hashes = 0;
        const worker = createWorker({ hash: () => {
            hashes++;
            // Too hard for difficulty 2, valid at difficulty 1.
            const value = hashes <= 2000 ? (1n << 256n) - 1n : diff1 * 3n / 4n;
            return Buffer.from(value.toString(16).padStart(64, '0'), 'hex').reverse();
        } });
        const socket = worker.subscribe();
        socket.feed({ id: 2, result: true });
        socket.feed(job());
        socket.feed({ method: 'mining.set_difficulty', params: [2] });
        worker.drain();
        assert.strictEqual(socket.writes.filter(m => m.method === 'mining.submit').length, 1);
        socket.feed(job('job2'));
        worker.fireTimer(100);
        worker.drain();
        assert.strictEqual(socket.writes.filter(m => m.method === 'mining.submit').length, 1);
    });

    check('clean work with a reused job ID cancels the previous header', () => {
        const headers = [];
        const worker = createWorker({ hash: header => {
            headers.push(Buffer.from(header));
            return Buffer.alloc(32, 0xff);
        } });
        const socket = worker.subscribe();
        socket.feed({ id: 2, result: true });
        socket.feed(job());
        const changed = job();
        changed.params[7] = '5e9e7c01';
        socket.feed(changed);
        worker.drain();
        assert.strictEqual(headers[2000].readUInt32LE(68), parseInt(changed.params[7], 16));
    });

    check('successive sweeps never hash the same header again', () => {
        const seen = new Set();
        let duplicates = 0;
        const worker = createWorker({ hash: header => {
            const hex = header.toString('hex');
            if (seen.has(hex)) duplicates++;
            seen.add(hex);
            return Buffer.alloc(32, 0xff);
        } });
        const socket = worker.subscribe();
        socket.feed({ id: 2, result: true });
        socket.feed(job());
        worker.drain();
        worker.fireTimer(100);
        worker.drain();
        assert.strictEqual(duplicates, 0);
        assert.strictEqual(seen.size, 20000);
    });

    check('real SHA-256 shares reconstruct at the pool and await acceptance', () => {
        const worker = createWorker();
        const socket = worker.subscribe();
        const notification = job();
        const target = diff1 * 100000000n; // difficulty 1e-8
        let expectedNonce = 0;
        while (numericHash(hash256(poolHeader(notification, '0000000000000000', expectedNonce))) > target) {
            assert.ok(++expectedNonce < 10000, 'fixture must find a share in one sweep');
        }
        socket.feed({ method: 'mining.set_difficulty', params: [1e-8] });
        socket.feed(notification);
        assert.strictEqual(worker.timers.length, 0, 'do not mine before authorization');
        socket.feed({ id: 2, result: true });
        worker.drain();
        const share = socket.writes.find(m => m.method === 'mining.submit');
        assert.ok(share, 'share must be submitted');
        assert.deepStrictEqual(share.params, ['test.worker', 'job1', '0000000000000000',
            notification.params[7], expectedNonce.toString(16).padStart(8, '0')]);
        assert.strictEqual(worker.messages.filter(m => m.type === 'share').length, 0,
            'submission is not acceptance');
        socket.feed({ id: share.id, result: true, error: null });
        assert.strictEqual(worker.messages.filter(m => m.type === 'share').length, 1);
        worker.fireTimer(100);
        worker.drain();
        const second = socket.writes.filter(m => m.method === 'mining.submit')[1];
        assert.ok(second, 'a second share must be found');
        assert.strictEqual(second.params[2], '0000000000000000');
        assert.ok(parseInt(second.params[4], 16) > expectedNonce, 'resume after the submitted nonce');
        assert.ok(numericHash(hash256(poolHeader(notification, second.params[2], parseInt(second.params[4], 16)))) <= target);
        socket.feed({ id: second.id, result: false, error: [23, 'Low difficulty share', null] });
        assert.strictEqual(worker.messages.filter(m => m.type === 'share_rejected').length, 1);
        assert.strictEqual(worker.messages.filter(m => m.type === 'share').length, 1);
    });

    check('reconnect invalidates queued mining callbacks', () => {
        let hashes = 0;
        const worker = createWorker({ hash: () => { hashes++; return Buffer.alloc(32, 0xff); } });
        const first = worker.subscribe();
        first.feed({ id: 2, result: true });
        first.feed({ method: 'mining.set_difficulty', params: [1e-8] });
        first.feed(job());
        first.emit('close');
        worker.fireTimer(5000);
        const second = worker.subscribe();
        second.feed({ id: 2, result: true });
        second.feed(job());
        worker.drain();
        assert.strictEqual(hashes, 12000, 'only the new session may finish a sweep');
        assert.strictEqual(worker.timers.filter(t => t.delay === 100).length, 1);
    });

    check('reconnect does not inherit the previous connection difficulty', () => {
        const worker = createWorker({ hash: () =>
            Buffer.from((diff1 * 3n / 4n).toString(16).padStart(64, '0'), 'hex').reverse() });
        const first = worker.subscribe();
        first.feed({ method: 'mining.set_difficulty', params: [2] });
        first.emit('close');
        worker.fireTimer(5000);
        const second = worker.subscribe();
        second.feed({ id: 2, result: true });
        second.feed(job());
        worker.drain();
        assert.ok(second.writes.some(m => m.method === 'mining.submit'));
    });

    check('nonce overflow rolls all eight extraNonce2 bytes and rebuilds the coinbase', () => {
        const headers = [];
        const worker = createWorker({ hash: header => {
            headers.push(Buffer.from(header));
            return Buffer.alloc(32); // force a share to inspect submission bytes
        } });
        const socket = worker.subscribe();
        const notification = job();
        socket.feed(notification);
        worker.setCursor(0xffffffff, 0x01020304050607ffn);
        socket.feed({ id: 2, result: true });
        worker.fireTimer(100);
        const shares = socket.writes.filter(m => m.method === 'mining.submit');
        assert.strictEqual(shares[0].params[2], '01020304050607ff');
        assert.strictEqual(shares[0].params[4], 'ffffffff');
        assert.strictEqual(shares[1].params[2], '0102030405060800');
        assert.strictEqual(shares[1].params[4], '00000000');
        assert.deepStrictEqual(headers[0], poolHeader(notification, shares[0].params[2], 0xffffffff));
        assert.deepStrictEqual(headers[1], poolHeader(notification, shares[1].params[2], 0));
    });

    check('CPU connections request difficulty 1', () => {
        const worker = createWorker();
        const socket = worker.subscribe();
        socket.feed({ id: 2, result: true });
        const request = socket.writes.find(m => m.method === 'mining.suggest_difficulty');
        assert.ok(request);
        assert.deepStrictEqual(request.params, [1]);
    });

    assert.strictEqual(failures.length, 0, failures.join('\n'));
};
