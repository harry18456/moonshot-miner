const { parentPort, workerData } = require('worker_threads');
const net = require('net');
const {
    sha256d,
    reverseBuffer,
    encodeExtraNonce2,
    buildBlockHeader,
    computeMerkleRoot,
} = require('./hash-utils');

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
let isAuthorized = false;
let difficulty = 1;
let reconnectTimer = null;
let isReconnecting = false;

// Pending shares for retry (must be defined before use in handleMessage)
const pendingShares = new Map();
let shareIdCounter = 100;

// Stratum Difficulty 1 Target (approximate for comparison)
// 0x00000000FFFF0000000000000000000000000000000000000000000000000000
const CNT_MAX_TARGET = BigInt('0x00000000FFFF0000000000000000000000000000000000000000000000000000');
let currentTarget = CNT_MAX_TARGET;

// --- CORE MINING LOGIC ---
// Pure hashing/serialization helpers (sha256d, reverseBuffer, swapEndian32,
// encodeExtraNonce2, buildBlockHeader, computeMerkleRoot) live in
// ./hash-utils.js and are unit-tested there against known block vectors.

function updateTarget() {
    // Ensure difficulty is positive
    if (!difficulty || difficulty <= 0) difficulty = 1;
    // Calculate new target based on difficulty.
    // target = diff_1_target / difficulty
    // To support fractional difficulty, multiply first then divide to maintain BigInt precision.
    // E.g., difficulty 0.5 → target = CNT_MAX_TARGET * 1000 / 500
    const scale = 1000000;
    const scaledDiff = Math.max(1, Math.round(difficulty * scale));
    const computed = (CNT_MAX_TARGET * BigInt(scale)) / BigInt(scaledDiff);
    // Clamp to max valid 256-bit hash value
    const MAX_HASH = (1n << 256n) - 1n;
    currentTarget = computed > MAX_HASH ? MAX_HASH : computed;
}

function scheduleReconnect() {
    if (reconnectTimer || isReconnecting) return;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        isReconnecting = true;
        connect();
    }, 5000);
}

function connect() {
    // Reset per-connection state; we must re-subscribe and re-authorize.
    // Also drop the stale job: the new subscribe overwrites extraNonce1, so a
    // leftover currentJob would let the authorize handler start mining on a
    // mismatched coinbase before the first fresh mining.notify arrives.
    isAuthorized = false;
    currentJob = null;
    // Reset the reconnect-in-progress flag HERE, not only in the 'connect'
    // success callback. Otherwise a reconnect that fails at the TCP layer
    // (error/close before 'connect') leaves isReconnecting stuck true and
    // scheduleReconnect() short-circuits forever — auto-reconnect would die.
    isReconnecting = false;

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
        isReconnecting = false;
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
        // Defend against a pool that never sends a newline (unbounded growth).
        if (buffer.length > 1000000) {
            buffer = '';
            parentPort.postMessage({ type: 'error', payload: 'Dropped oversized pool response' });
            return;
        }
        let idx;
        while ((idx = buffer.indexOf('\n')) !== -1) {
            const line = buffer.substring(0, idx);
            buffer = buffer.substring(idx + 1);
            if (!line.trim()) continue;
            try {
                const message = JSON.parse(line);
                handleMessage(message);
            } catch (e) {
                parentPort.postMessage({ type: 'error', payload: `Pool message parse error: ${e.message}` });
            }
        }
    });

    socket.on('error', (err) => {
        isMining = false;
        parentPort.postMessage({ type: 'error', payload: err.message });
        scheduleReconnect();
    });

    socket.on('close', () => {
        parentPort.postMessage({ type: 'status', payload: 'Disconnected' });
        isMining = false;
        // Clear pending shares on disconnect (jobs are now stale)
        pendingShares.clear();
        scheduleReconnect();
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

        if (!extraNonce1 || !Number.isInteger(extraNonce2Size) || extraNonce2Size < 1 || extraNonce2Size > 8) {
            parentPort.postMessage({ type: 'error', payload: 'Subscribe failed: invalid extraNonce data' });
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
        if (msg.result === true) {
            isAuthorized = true;
            parentPort.postMessage({ type: 'status', payload: 'Authorized' });
            // A job may have arrived before authorization completed; start now if so.
            if (currentJob && !isMining) {
                parentPort.postMessage({ type: 'status', payload: 'Running (New Job)' });
                startMiningLoop();
            }
        } else {
            isAuthorized = false;
            const reason = msg.error ? (msg.error[1] || JSON.stringify(msg.error)) : 'check wallet address';
            parentPort.postMessage({ type: 'error', payload: `Authorization failed (${reason})` });
        }
    }

    if (msg.method === 'mining.set_difficulty') {
        // Reject non-finite / non-positive values (e.g. 1e400 -> Infinity), which
        // would throw in updateTarget()'s BigInt conversion and be swallowed,
        // leaving the miner comparing against a stale (easier) target.
        if (msg.params && Number.isFinite(msg.params[0]) && msg.params[0] > 0) {
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
                type: 'share_rejected',
                payload: `✗ Share REJECTED: ${errorMsg} (id: ${msg.id})`
            });
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
            if (!Array.isArray(msg.params[4])) {
                parentPort.postMessage({ type: 'error', payload: 'Invalid mining.notify: merkleBranch not an array' });
                return;
            }
            const prevHash = Buffer.from(msg.params[1], 'hex'); // 32 bytes
            const coinb1 = Buffer.from(msg.params[2], 'hex');
            const coinb2 = Buffer.from(msg.params[3], 'hex');
            const merkleBranch = msg.params[4].map(h => Buffer.from(h, 'hex'));
            const version = Buffer.from(msg.params[5], 'hex'); // 4 bytes
            const nbits = Buffer.from(msg.params[6], 'hex');   // 4 bytes
            const ntime = Buffer.from(msg.params[7], 'hex');   // 4 bytes
            const cleanJobs = msg.params[8];

            // Buffer.from(hex) silently truncates malformed/odd-length hex; verify
            // decoded field lengths so a bad job is rejected, not mined as garbage.
            if (prevHash.length !== 32 || version.length !== 4 || nbits.length !== 4 ||
                ntime.length !== 4 || !merkleBranch.every(b => b.length === 32)) {
                parentPort.postMessage({ type: 'error', payload: 'Invalid mining.notify field lengths' });
                return;
            }

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

            // Only mine once the pool has authorized us; otherwise every share
            // would be rejected as "unauthorized". Don't post a running status
            // here when unauthorized, so a prior auth error stays visible.
            if (isAuthorized) {
                parentPort.postMessage({ type: 'status', payload: 'Running (New Job)' });
                if (!isMining) startMiningLoop();
            }
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
    // extraNonce2 padded to extraNonce2Size (bytes). Shared encoder keeps this
    // byte-for-byte identical to what mining.submit sends.
    const en2 = encodeExtraNonce2(extraNonce2, extraNonce2Size);

    const coinbase = Buffer.concat([
        currentJob.coinb1,
        Buffer.from(extraNonce1, 'hex'),
        en2,
        currentJob.coinb2
    ]);

    return computeMerkleRoot(coinbase, currentJob.merkleBranch);
}

/**
 * Main Mining Function
 * Builds the 80-byte header once, then sweeps nonces in small chunks, yielding
 * to the event loop (setImmediate) between chunks so incoming jobs /
 * set_difficulty / share responses are processed promptly. The inter-cycle
 * sleep (intensity) is applied once per full sweep, so sustained throughput
 * matches the old single synchronous batch.
 */
function mine() {
    if (!isMining) return;
    if (!currentJob || !extraNonce1) {
        setTimeout(mine, 100);
        return;
    }

    // Snapshot everything the header is built from, so a job/difficulty update
    // arriving during a setImmediate yield cannot desync the hashed header from
    // the values we submit. Wrapped in try/catch so a malformed job posts an
    // error instead of crashing the whole worker thread.
    let header, jobId, ntime, en2;
    try {
        const merkleRoot = calculateMerkleRoot();
        jobId = currentJob.jobId;
        ntime = currentJob.ntime;
        en2 = extraNonce2;
        header = buildBlockHeader({
            version: currentJob.version,
            prevHash: currentJob.prevHash,
            merkleRoot,
            ntime,
            nbits: currentJob.nbits,
            nonce: 0
        });
    } catch (e) {
        parentPort.postMessage({ type: 'error', payload: `Failed to build header: ${e.message}` });
        isMining = false; // a fresh job or a reconnect will restart the loop
        return;
    }

    const TARGET_HASHES = 10000;
    const CHUNK = 2000;
    let hashCount = 0;
    let currentNonce = Math.floor(Math.random() * 0xFFFFFFFF);
    const start = Date.now();

    function reportAndSleep() {
        // SUSTAINED hashrate: fold the inter-cycle sleep into the duration so the
        // displayed rate reflects real throughput, not the compute burst.
        const sleepMs = intensity || 100;
        const cycleMs = (Date.now() - start) + sleepMs;
        const hashrate = Math.floor((hashCount / (cycleMs || 1)) * 1000);
        parentPort.postMessage({ type: 'hashrate', payload: hashrate });
        setTimeout(mine, sleepMs);
    }

    function runChunk() {
        if (!isMining) return;
        // If the job changed during a yield, abandon this stale sweep and rebuild.
        if (!currentJob || currentJob.jobId !== jobId) {
            setImmediate(mine);
            return;
        }
        const stop = Math.min(hashCount + CHUNK, TARGET_HASHES);
        for (; hashCount < stop; hashCount++) {
            header.writeUInt32LE(currentNonce, 76);
            const hash = sha256d(header); // 32 bytes
            // Interpret the hash big-endian (reverse) and compare to the target.
            const hashNum = BigInt('0x' + reverseBuffer(hash).toString('hex'));
            if (hashNum <= currentTarget) {
                // FOUND A SHARE! Submit with the SNAPSHOT values matching this header.
                submitShare(jobId, en2, ntime, currentNonce);
                // Advance extraNonce2 for a fresh coinbase next cycle (overflow-safe,
                // capped to 6 bytes to stay within JS safe-integer range).
                const safeSize = Math.min(extraNonce2Size, 6);
                const maxExtraNonce2 = Math.pow(2, safeSize * 8) - 1;
                extraNonce2 = (extraNonce2 + 1) % (maxExtraNonce2 + 1);
                hashCount++;
                reportAndSleep();
                return;
            }
            currentNonce = (currentNonce + 1) >>> 0; // wrap
        }
        if (hashCount < TARGET_HASHES) {
            setImmediate(runChunk); // yield so socket data is processed between chunks
        } else {
            reportAndSleep();
        }
    }

    runChunk();
}

function submitShare(jobId, en2Int, ntime, nonceInt) {
    // Format hex strings
    // extraNonce2: same big-endian bytes used to build the coinbase
    const en2Hex = encodeExtraNonce2(en2Int, extraNonce2Size).toString('hex');

    // ntime: Hex string (same as received from job)
    const ntimeHex = ntime.toString('hex');

    // nonce: Must be Big Endian hex string for Stratum protocol
    // (matches cgminer's sprintf("%08x", nonce) format)
    const nonceHex = (nonceInt >>> 0).toString(16).padStart(8, '0');

    const shareId = shareIdCounter++;

    // Store to track response
    pendingShares.set(shareId, { timestamp: Date.now() });

    // Cleanup stale pending shares (older than 60s)
    const now = Date.now();
    for (const [id, share] of pendingShares) {
        if (now - share.timestamp > 60000) {
            pendingShares.delete(id);
        }
    }

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
