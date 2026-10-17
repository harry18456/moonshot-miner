// Pure, side-effect-free Bitcoin hashing/serialization helpers.
// Extracted from the worker so they can be unit-tested against known block
// vectors without the worker_threads/net side effects (the worker runs
// connect() at require-time). Keep these PURE: Buffers/ints in, Buffers/ints out.

const crypto = require('crypto');

const DIFF1_TARGET = BigInt('0x00000000ffff0000000000000000000000000000000000000000000000000000');

// Convert the pool's decimal difficulty without rounding away small fractions
// or overflowing Number when scaling large values.
function difficultyToTarget(difficulty) {
    if (!Number.isFinite(difficulty) || difficulty <= 0) {
        throw new RangeError('Difficulty must be finite and positive');
    }
    const [mantissa, exponent = '0'] = difficulty.toString().split('e');
    const [whole, fraction = ''] = mantissa.split('.');
    let numerator = BigInt(whole + fraction);
    let denominator = 1n;
    const power = Number(exponent) - fraction.length;
    if (power >= 0) numerator *= 10n ** BigInt(power);
    else denominator = 10n ** BigInt(-power);
    const target = DIFF1_TARGET * denominator / numerator;
    const maxHash = (1n << 256n) - 1n;
    return target > maxHash ? maxHash : target;
}

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

function sha256d(buffer) {
    return sha256(sha256(buffer));
}

// Full byte reversal (e.g. BE hex field -> LE header field, or hash -> compare order).
function reverseBuffer(buff) {
    const reversed = Buffer.alloc(buff.length);
    for (let i = 0; i < buff.length; i++) {
        reversed[i] = buff[buff.length - 1 - i];
    }
    return reversed;
}

// Swap endianness of each 4-byte word (Stratum prevHash format <-> header LE).
function swapEndian32(buffer) {
    const result = Buffer.alloc(buffer.length);
    for (let i = 0; i < buffer.length; i += 4) {
        result[i] = buffer[i + 3];
        result[i + 1] = buffer[i + 2];
        result[i + 2] = buffer[i + 1];
        result[i + 3] = buffer[i];
    }
    return result;
}

// Encode extraNonce2 as a big-endian buffer of exactly `size` bytes.
// BigInt-based so the SAME encoding is shared by the coinbase build and the
// share submission — any divergence makes the pool rebuild a different coinbase.
function encodeExtraNonce2(value, size) {
    const buf = Buffer.alloc(size);
    let v = BigInt(value);
    for (let i = size - 1; i >= 0; i--) {
        buf[i] = Number(v & 0xffn);
        v >>= 8n;
    }
    return buf;
}

// Assemble the 80-byte block header from Stratum-format fields.
// version/ntime/nbits: 4-byte buffers as received (big-endian) -> reversed to LE.
// prevHash: 32-byte buffer as received (each 4-byte word swapped) -> swapEndian32.
// merkleRoot: 32-byte buffer already in internal order -> copied as-is.
// nonce: uint32 -> written little-endian at offset 76.
function buildBlockHeader({ version, prevHash, merkleRoot, ntime, nbits, nonce }) {
    const header = Buffer.alloc(80);
    reverseBuffer(version).copy(header, 0);     // [0..4)
    swapEndian32(prevHash).copy(header, 4);     // [4..36)
    merkleRoot.copy(header, 36);                // [36..68)
    reverseBuffer(ntime).copy(header, 68);      // [68..72)
    reverseBuffer(nbits).copy(header, 72);      // [72..76)
    header.writeUInt32LE((nonce >>> 0), 76);    // [76..80)
    return header;
}

// Merkle root from the coinbase hash folded with each branch (all internal order).
function computeMerkleRoot(coinbase, merkleBranch) {
    let root = sha256d(coinbase);
    for (const branch of merkleBranch) {
        root = sha256d(Buffer.concat([root, branch]));
    }
    return root;
}

module.exports = {
    DIFF1_TARGET,
    difficultyToTarget,
    sha256,
    sha256d,
    reverseBuffer,
    swapEndian32,
    encodeExtraNonce2,
    buildBlockHeader,
    computeMerkleRoot,
};
