const { parentPort, workerData } = require('worker_threads');
const crypto = require('crypto');
const net = require('net');

// Configuration
const POOL_HOST = 'solo.ckpool.org';
const POOL_PORT = 3333;
const { walletAddress, intensity } = workerData;

let socket = null;
let currentJob = null;
let extraNonce1 = null;
let extraNonce2Size = null;
let extraNonce2 = 0;
let isMining = false;
let difficulty = 1;

// Pending shares for retry (must be defined before use in handleMessage)
const pendingShares = new Map();
let shareIdCounter = 100;

// Stratum Difficulty 1 Target (approximate for comparison)
// 0x00000000FFFF0000000000000000000000000000000000000000000000000000
const CNT_MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
let currentTarget = CNT_MAX_TARGET;

// --- UTILITIES ---

function sha256(buffer) {
    return crypto.createHash('sha256').update(buffer).digest();
}

function sha256d(buffer) {
    return sha256(sha256(buffer));
}

function reverseBuffer(buff) {
    const reversed = Buffer.alloc(buff.length);
    for (let i = 0; i < buff.length; i++) {
        reversed[i] = buff[buff.length - 1 - i];
    }
    return reversed;
}

// Swap endianness of each 4-byte word (for Stratum prevHash format)
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

// Convert Hex String to Buffer (reversing if needed for little endian handling inherent in some fields)
// But typically, Stratum hex strings are Big Endian. Internal hashing needs Little Endian.
// We'll use specific helpers.

// --- CORE MINING LOGIC ---

function updateTarget() {
    // Ensure difficulty is at least 1 (handles <= 0 and fractional < 1)
    if (!difficulty || difficulty < 1) difficulty = 1;
    // Calculate new target based on difficulty.
    // target = diff_1_target / difficulty
    // We use BigInt division (floor difficulty to avoid division by zero).
    const diffInt = Math.max(1, Math.floor(difficulty));
    currentTarget = CNT_MAX_TARGET / BigInt(diffInt);
}

function connect() {
    // Clean up old socket if exists
    if (socket) {
        socket.removeAllListeners();
        socket.destroy();
        socket = null;
    }

    parentPort.postMessage({ type: 'status', payload: 'Connecting...' });

    socket = new net.Socket();
    socket.setEncoding('utf8');

    socket.connect(POOL_PORT, POOL_HOST, () => {
        parentPort.postMessage({ type: 'status', payload: 'Connected' });

        const subscribeReq = {
            id: 1,
            method: 'mining.subscribe',
            params: ['MoonshotMiner/1.0']
        };
        sendJson(subscribeReq);
    });

    let buffer = '';

    socket.on('data', (data) => {
        buffer += data;
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, idx);
            buffer = buffer.substring(idx + 1);
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                handleMessage(message);
            } catch (e) {
                console.error('Parse error:', e);
            }
        }
    });

    socket.on('error', (err) => {
        parentPort.postMessage({ type: 'error', payload: err.message });
        setTimeout(connect, 5000);
    });

    socket.on('close', () => {
        parentPort.postMessage({ type: 'status', payload: 'Disconnected' });
        isMining = false;
        // Clear pending shares on disconnect (jobs are now stale)
        pendingShares.clear();
        setTimeout(connect, 5000);
    });
}

function sendJson(data) {
    if (socket && !socket.destroyed) {
        socket.write(JSON.stringify(data) + '\n');
    }
}

function handleMessage(msg) {
    if (msg.id === 1) { // Subscribe
        // result: [ [ ["mining.set_difficulty", "subscription id 1"], ...], extraNonce1, extraNonce2_size ]
        if (!msg.result || !Array.isArray(msg.result) || msg.result.length < 3) {
            parentPort.postMessage({ type: 'error', payload: 'Subscribe failed: invalid response' });
            return;
        }
        extraNonce1 = msg.result[1];
        extraNonce2Size = msg.result[2];

        if (!extraNonce1 || typeof extraNonce2Size !== 'number') {
            parentPort.postMessage({ type: 'error', payload: 'Subscribe failed: missing extraNonce data' });
            return;
        }

        // Authorize with wallet
        const authReq = {
            id: 2,
            method: 'mining.authorize',
            params: [walletAddress, 'x']
        };
        sendJson(authReq);
    }

    if (msg.id === 2) { // Authorize
        if (msg.result) {
            parentPort.postMessage({ type: 'status', payload: 'Authorized' });
        } else {
            parentPort.postMessage({ type: 'error', payload: 'Auth Failed' });
        }
    }

    if (msg.method === 'mining.set_difficulty') {
        if (msg.params && typeof msg.params[0] === 'number') {
            difficulty = msg.params[0];
            updateTarget();
        }
    }

    // Handle share submission response (id >= 100)
    if (msg.id >= 100 && pendingShares.has(msg.id)) {
        pendingShares.delete(msg.id);

        if (msg.result === true) {
            parentPort.postMessage({
                type: 'share',
                payload: `✓ Share ACCEPTED! (id: ${msg.id})`
            });
        } else {
            const errorMsg = msg.error ? (msg.error[1] || msg.error) : 'Unknown error';
            parentPort.postMessage({
                type: 'error',
                payload: `Share rejected: ${errorMsg}`
            });
            // Note: No retry for rejected shares - typically stale/duplicate/invalid
        }
    }

    if (msg.method === 'mining.notify') {
        // params: [jobId, prevHash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs]
        if (!msg.params || !Array.isArray(msg.params) || msg.params.length < 9) {
            parentPort.postMessage({ type: 'error', payload: 'Invalid mining.notify params' });
            return;
        }

        // Stratum sends values as Big Endian Hex strings usually.
        // We need to store them.
        try {
            const jobId = msg.params[0];
            const prevHash = Buffer.from(msg.params[1], 'hex'); // 32 bytes
            const coinb1 = Buffer.from(msg.params[2], 'hex');
            const coinb2 = Buffer.from(msg.params[3], 'hex');
            const merkleBranch = msg.params[4].map(h => Buffer.from(h, 'hex'));
            const version = Buffer.from(msg.params[5], 'hex'); // 4 bytes
            const nbits = Buffer.from(msg.params[6], 'hex');   // 4 bytes
            const ntime = Buffer.from(msg.params[7], 'hex');   // 4 bytes
            const cleanJobs = msg.params[8];

            if (cleanJobs) {
                extraNonce2 = 0;
                // Clear job queue if implemented, here we just switch current job
            }

            currentJob = {
                jobId,
                prevHash,
                coinb1,
                coinb2,
                merkleBranch,
                version,
                nbits,
                ntime
            };

            parentPort.postMessage({ type: 'status', payload: 'Running (New Job)' });
            if (!isMining) startMiningLoop();
        } catch (e) {
            parentPort.postMessage({ type: 'error', payload: `Failed to parse job: ${e.message}` });
        }
    }
}

function startMiningLoop() {
    if (isMining) return;
    isMining = true;
    mine();
}

/**
 * Constructs the Coinbase Transaction and calculates Merkle Root
 * @returns {Buffer} 32-byte Merkle Root
 */
function calculateMerkleRoot() {
    // 1. Build Coinbase
    // extraNonce2 must be padded to extraNonce2Size (bytes)
    const en2 = Buffer.alloc(extraNonce2Size);

    // Handle different extraNonce2Size values safely
    if (extraNonce2Size >= 4) {
        // Write 4-byte value at the end (big endian, left-padded with zeros)
        en2.writeUInt32BE(extraNonce2 >>> 0, extraNonce2Size - 4);
    } else {
        // For smaller sizes, write only the least significant bytes
        for (let i = 0; i < extraNonce2Size; i++) {
            en2[extraNonce2Size - 1 - i] = (extraNonce2 >> (i * 8)) & 0xff;
        }
    }

    const coinbase = Buffer.concat([
        currentJob.coinb1,
        Buffer.from(extraNonce1, 'hex'),
        en2,
        currentJob.coinb2
    ]);

    // 2. Hash Coinbase (SHA256d)
    let merkleRoot = sha256d(coinbase);

    // 3. Compute Merkle Root using branch
    for (const branch of currentJob.merkleBranch) {
        // Concatenate: Hash(Current + Branch)
        merkleRoot = sha256d(Buffer.concat([merkleRoot, branch]));
    }

    return merkleRoot;
}

/**
 * Main Mining Function
 * Attempts to solve the block by iterating nonces.
 */
function mine() {
    if (!isMining) return;
    if (!currentJob || !extraNonce1) {
        setTimeout(mine, 100);
        return;
    }

    // 1. Prepare Header Components
    const merkleRoot = calculateMerkleRoot();

    // Stratum fields handling for Header Construction.
    // Bitcoin Block Header (80 bytes) structure:
    // [Version (4)] [PrevHash (32)] [MerkleRoot (32)] [Time (4)] [NBits (4)] [Nonce (4)]
    // IMPORTANT: Stratum protocol usually sends these as Big-Endian Hex strings.
    // Bitcoin SHA256 hashing internally treats them as Little-Endian 32-bit words (or full LE bytes).
    // Specifically:
    // Version: LE
    // PrevHash: LE (Usually stratum sends this byte-swapped; if not, we must reverse). 
    //           Usually stratum notify prevhash is already formatted such that we treat it as 8x 32-bit LE words?
    //           Standard practice: The hex string from stratum is reversed 32-bit chunks or fully reversed.
    //           Let's try standard Full Reverse for PrevHash and MerkleRoot which is common for "Block Hashing".

    // Construct Header Buffer
    const header = Buffer.alloc(80);

    // Version: Str sent as BE hex, write as LE
    // Actually, simple rule: Reverse the Buffer derived from the Hex string for all 32-byte fields, 
    // and reverse the 4-byte fields if they came as BE hex.

    // Version
    reverseBuffer(currentJob.version).copy(header, 0);

    // PrevHash: Stratum sends prevhash with each 4-byte word swapped.
    // We need to swap each 4-byte chunk back to get the correct LE format for hashing.
    const prevHashLE = swapEndian32(currentJob.prevHash);
    prevHashLE.copy(header, 4);

    // Merkle Root: sha256d output is already in the correct byte order for the header.
    // No reversal needed - use directly.
    merkleRoot.copy(header, 36);

    // Time
    reverseBuffer(currentJob.ntime).copy(header, 68);

    // NBits
    reverseBuffer(currentJob.nbits).copy(header, 72);

    // Nonce (Placeholder at 76, 4 bytes)

    // 2. Mining Loop
    // We will scan a range of nonces.
    // Speed depends on 'intensity' (sleep time).
    // To make it feel "real" but "slow" as requested, we do a small batch then sleep.

    const batchSize = 10000;
    // If intensity is high (long sleep), we do a burst then sleep.

    let hashCount = 0;
    let currentNonce = Math.floor(Math.random() * 0xFFFFFFFF);

    const start = Date.now();

    for (let i = 0; i < batchSize; i++) {
        hashCount++;
        // Write Nonce (LE)
        header.writeUInt32LE(currentNonce, 76);

        // Double Hash
        const hash = sha256d(header); // Result is 32 bytes

        // Compare with Target
        // We need to interpret the hash as a number (Little Endian usually for comparison)
        // or just Reverse it to BE and compare with BigInt Target.
        const hashNum = BigInt('0x' + reverseBuffer(hash).toString('hex'));

        if (hashNum <= currentTarget) {
            // FOUND A SHARE!
            submitShare(currentJob.jobId, extraNonce2, currentJob.ntime, currentNonce);
            // Increment extraNonce2 to generate new coinbase for next search
            // Handle overflow based on extraNonce2Size (max value is 2^(size*8) - 1)
            const maxExtraNonce2 = Math.pow(2, extraNonce2Size * 8) - 1;
            extraNonce2 = (extraNonce2 + 1) % (maxExtraNonce2 + 1);
            // Break to recalculate merkle root with new extraNonce2
            break;
        }

        currentNonce = (currentNonce + 1) >>> 0; // Ensure logic wrap
    }

    const end = Date.now();

    // Report Hashrate (use actual hash count, not batchSize)
    const duration = end - start;
    const hashrate = Math.floor((hashCount / (duration || 1)) * 1000);
    parentPort.postMessage({ type: 'hashrate', payload: hashrate });

    // Increment ExtraNonce2 occasionally if we exhaust nonces? 
    // For this slow miner, we just change random nonce start.

    // Sleep based on intensity
    // intensity is "sleep time in ms". 
    // Higher intensity = Slower mining (more sleep).
    setTimeout(mine, intensity || 100);
}

function submitShare(jobId, en2Int, ntime, nonceInt) {
    // Format hex strings
    // extraNonce2: Hex string, padded
    const en2Hex = en2Int.toString(16).padStart(extraNonce2Size * 2, '0');

    // ntime: Hex string (same as received from job)
    const ntimeHex = ntime.toString('hex');

    // nonce: Must be Big Endian hex string for Stratum protocol
    // (matches cgminer's sprintf("%08x", nonce) format)
    const nonceHex = (nonceInt >>> 0).toString(16).padStart(8, '0');

    const shareId = shareIdCounter++;

    // Store to track response
    pendingShares.set(shareId, { timestamp: Date.now() });

    const submitReq = {
        id: shareId,
        method: 'mining.submit',
        params: [
            walletAddress,
            jobId,
            en2Hex,
            ntimeHex,
            nonceHex
        ]
    };

    sendJson(submitReq);
    parentPort.postMessage({ type: 'share', payload: `Share submitted (id: ${shareId})` });
}

// Start
connect();
