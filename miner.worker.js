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

// Convert Hex String to Buffer (reversing if needed for little endian handling inherent in some fields)
// But typically, Stratum hex strings are Big Endian. Internal hashing needs Little Endian.
// We'll use specific helpers.

// --- CORE MINING LOGIC ---

function updateTarget() {
    if (difficulty <= 0) difficulty = 1;
    // Calculate new target based on difficulty. 
    // target = diff_1_target / difficulty
    // We use BigInt division.
    currentTarget = CNT_MAX_TARGET / BigInt(Math.floor(difficulty));
}

function connect() {
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
        extraNonce1 = msg.result[1];
        extraNonce2Size = msg.result[2];

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
        difficulty = msg.params[0];
        updateTarget();
    }

    if (msg.method === 'mining.notify') {
        // params: [jobId, prevHash, coinb1, coinb2, merkleBranch, version, nbits, ntime, cleanJobs]

        // Stratum sends values as Big Endian Hex strings usually.
        // We need to store them.

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
    en2.writeUInt32BE(extraNonce2, extraNonce2Size - 4 > 0 ? extraNonce2Size - 4 : 0);
    // ^ Simple incrementing. BE or LE depends on pool, usually BE for EN2 in generation provided validation? 
    // Actually most stratum docs say EN2 is just bytes to append.

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

    // PrevHash: Usually stratum requires us to use it as-is or swap. 
    // For standard SHA256d block hashing, we need LE. 
    // The pool sends it in a specific format. ckpool usually sends BE. We swap to LE.
    // However, if the pool sends "8-byte swapped", it's messy. 
    // Let's assume standard BE -> LE reversal.
    // Note: msg.params[1] is prevhash.
    const prevHashLE = reverseBuffer(currentJob.prevHash);
    prevHashLE.copy(header, 4);

    // Merkle Root: We calculated it above. It is the result of SHA256d, which is usually BE? 
    // We need to reverse it to LE for the header.
    const merkleRootLE = reverseBuffer(merkleRoot);
    merkleRootLE.copy(header, 36);

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

    let found = false;
    let currentNonce = 0; // In a real miner we'd randomize or track this better.

    // Use a random start nonce for every batch to avoid repeating 0-10000 endlessly if we re-enter 'mine' fast
    currentNonce = Math.floor(Math.random() * 0xFFFFFFFF);

    const start = Date.now();

    for (let i = 0; i < batchSize; i++) {
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
            found = true;
            submitShare(currentJob.jobId, extraNonce2, currentJob.ntime, currentNonce);
            // Don't stop, just keep going or break? Usually break to process next nonce.
            break;
        }

        currentNonce = (currentNonce + 1) >>> 0; // Ensure logic wrap
    }

    const end = Date.now();

    // Report Hashrate
    const duration = end - start;
    const hashrate = Math.floor((batchSize / (duration || 1)) * 1000);
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

    // ntime: Hex string (BE originally from job? No, we need to send what we used).
    // Stratum expect ntime as hex string (usually same as received if we didn't roll it).
    const ntimeHex = ntime.toString('hex');

    // nonce: Hex string. 
    const nonceHex = nonceInt.toString(16).padStart(8, '0');
    // Careful: is it BE or LE string? Stratum usually expects header-formatted hex?
    // Actually stratum submit format: params: [user, jobId, extraNonce2, ntime, nonce]
    // Nonce is usually sent as BE hex string or LE? 
    // cgminer sends it reversed? Let's send it as hex string of the value we put in.

    // We send the 'submit' message
    const submitReq = {
        id: 4,
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
    parentPort.postMessage({ type: 'share', payload: 'Share Found & Submitted!' });
}

// Start
connect();
