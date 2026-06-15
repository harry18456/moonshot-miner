const assert = require('assert');
const {
    sha256d,
    reverseBuffer,
    swapEndian32,
    encodeExtraNonce2,
    buildBlockHeader,
    computeMerkleRoot,
} = require('../hash-utils');

// Independent helpers (NOT the module's) so the buildBlockHeader test is non-circular.
function indieReverse(buf) {
    return Buffer.from(buf).reverse();
}
function indieSwap32(buf) {
    const r = Buffer.alloc(buf.length);
    for (let i = 0; i < buf.length; i += 4) {
        r[i] = buf[i + 3];
        r[i + 1] = buf[i + 2];
        r[i + 2] = buf[i + 1];
        r[i + 3] = buf[i];
    }
    return r;
}

module.exports = function run() {
    // Known-answer vector: Bitcoin block #125552 (the canonical block-hashing example).
    const rawHeaderHex =
        '01000000' +
        '81cd02ab7e569e8bcd9317e2fe99f2de44d49ab2b8851ba4a308000000000000' +
        'e320b6c2fffc8d750423db8b1eb942ae710e951ed797f7affc8892b0f1fc122b' +
        'c7f5d74d' +
        'f2b9441a' +
        '42a14695';
    const knownHash = '00000000000000001e8d6829a8a21adc5d38d0a473b144b6765798e61f98bd1d';
    const raw = Buffer.from(rawHeaderHex, 'hex');
    assert.strictEqual(raw.length, 80, 'raw header must be 80 bytes');

    // 1) sha256d + reverseBuffer reproduce the published block hash (proves the
    //    hashing + comparison byte order is correct).
    assert.strictEqual(
        reverseBuffer(sha256d(raw)).toString('hex'),
        knownHash,
        'sha256d(header) reversed must equal the published block hash'
    );

    // 2) buildBlockHeader reassembles the EXACT raw header from Stratum-format
    //    fields derived with independent reverse/swap helpers (non-circular).
    const fields = {
        version: indieReverse(raw.subarray(0, 4)),
        prevHash: indieSwap32(raw.subarray(4, 36)),
        merkleRoot: raw.subarray(36, 68),
        ntime: indieReverse(raw.subarray(68, 72)),
        nbits: indieReverse(raw.subarray(72, 76)),
        nonce: raw.readUInt32LE(76),
    };
    const built = buildBlockHeader(fields);
    assert.strictEqual(built.toString('hex'), rawHeaderHex, 'buildBlockHeader must reproduce the raw header');
    assert.strictEqual(
        reverseBuffer(sha256d(built)).toString('hex'),
        knownHash,
        'assembled header must hash to the block hash'
    );

    // 3) swapEndian32 is its own inverse per 4-byte word.
    const pv = raw.subarray(4, 36);
    assert.strictEqual(swapEndian32(swapEndian32(pv)).toString('hex'), pv.toString('hex'), 'swapEndian32 self-inverse');

    // 4) encodeExtraNonce2 — coinbase build and submit paths share this encoder.
    assert.strictEqual(encodeExtraNonce2(1, 4).toString('hex'), '00000001');
    assert.strictEqual(encodeExtraNonce2(258, 2).toString('hex'), '0102');
    assert.strictEqual(encodeExtraNonce2(0x010203, 3).toString('hex'), '010203');
    assert.strictEqual(encodeExtraNonce2(0, 8).toString('hex'), '0000000000000000');

    // 5) computeMerkleRoot: no branch == sha256d(coinbase); one branch folds right.
    const cb = Buffer.from('deadbeefcafe', 'hex');
    assert.strictEqual(computeMerkleRoot(cb, []).toString('hex'), sha256d(cb).toString('hex'));
    const branch = Buffer.alloc(32, 0xab);
    const expected = sha256d(Buffer.concat([sha256d(cb), branch]));
    assert.strictEqual(computeMerkleRoot(cb, [branch]).toString('hex'), expected.toString('hex'));

    console.log('  hash-utils: KAT block #125552 verified + encoder/merkle checks passed');
};
