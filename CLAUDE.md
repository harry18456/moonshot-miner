# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Moonshot Miner is a lightweight, cross-platform Bitcoin solo mining application built with Electron. It runs in the system tray and mines directly to `solo.ckpool.org` using CPU-based mining. This is an educational/lottery-ticket project - CPU mining has astronomically low probability of success.

## Commands

```bash
# Install dependencies
npm install

# Run in development mode
npm start

# Build for distribution (Windows .exe, macOS .dmg, Linux .AppImage)
npm run dist

# Windows build with admin elevation (required for symbolic links)
.\build_helper.bat
```

## Architecture

### Process Model (Electron IPC)

```
┌─────────────────────────────────────┐
│  RENDERER (renderer.js)             │
│  Vanilla DOM manipulation, no React │
└──────────────┬──────────────────────┘
               │ IPC via preload.js
┌──────────────▼──────────────────────┐
│  MAIN (main.js)                     │
│  Window/tray management, config     │
│  Worker thread lifecycle            │
└──────────────┬──────────────────────┘
               │ Worker Threads API
┌──────────────▼──────────────────────┐
│  WORKER (miner.worker.js)           │
│  Stratum protocol, SHA256d hashing  │
│  Nonce iteration, share submission  │
└─────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `main.js` | Electron lifecycle, window/tray creation, IPC handlers, worker management |
| `renderer.js` | UI interactions, DOM updates, config form handling |
| `preload.js` | Context-isolated IPC bridge exposing `window.api` |
| `miner.worker.js` | Stratum protocol client, mining loop, hash calculations |
| `index.html` | Single-page UI template |
| `styles.css` | Dark semi-transparent theme with Bitcoin orange accents |

### IPC Communication

**Renderer → Main (invoke):**
- `get-config`, `save-config`, `start-miner`, `stop-miner`, `get-app-version`, `resize-me`

**Main → Renderer (send):**
- `worker-message` (hashrate updates)
- `status-update` (IDLE, CONNECTING, MINING, ERROR, SUBMITTED)

### Worker Message Protocol

```javascript
{ type: 'status' | 'hashrate' | 'error' | 'share', payload: string | number }
```

### Stratum Protocol

The worker implements Stratum V1 mining protocol:
1. TCP connect to `solo.ckpool.org:3333`
2. `mining.subscribe` → receive extraNonce1, extraNonce2_size
3. `mining.authorize` with wallet address
4. `mining.notify` → receive job (block template)
5. Mining loop: construct header, iterate nonces, check against difficulty target
6. `mining.submit` when share found

### Block Header Construction (Critical)

Bitcoin block header is 80 bytes. Byte order handling is crucial:

```
[Version: 4B] [PrevHash: 32B] [MerkleRoot: 32B] [Time: 4B] [Bits: 4B] [Nonce: 4B]
```

| Field | Stratum Format | Header Format | Conversion |
|-------|---------------|---------------|------------|
| version | BE hex | LE bytes | `reverseBuffer()` |
| prevHash | 4-byte word swapped | LE bytes | `swapEndian32()` |
| merkleRoot | (computed) | direct | no conversion |
| ntime | BE hex | LE bytes | `reverseBuffer()` |
| nbits | BE hex | LE bytes | `reverseBuffer()` |
| nonce | (iterated) | LE bytes | `writeUInt32LE()` |

**Share submission format:**
- `extraNonce2`: BE hex string, padded to `extraNonce2Size * 2` chars
- `ntime`: original hex from job
- `nonce`: BE hex string (matches cgminer's `sprintf("%08x", nonce)`)

### Configuration

Persisted via `electron-store` at:
- Windows: `%APPDATA%\MoonshotMiner\config.json`
- macOS: `~/Library/Application Support/MoonshotMiner/config.json`
- Linux: `~/.config/MoonshotMiner/config.json`

```javascript
{
  walletAddress: '',      // Required BTC address
  intensity: 100,         // Sleep ms between nonce batches (0-1000)
  minimalMode: false,     // Hide hashrate & title
  autoStart: false,       // Auto-start mining on launch
  openAtLogin: false      // Run app on OS startup
}
```

### Security Configuration

- `contextIsolation: true` - Renderer cannot access Node.js
- `nodeIntegration: false` - No direct Node in renderer
- Preload bridge restricts API surface to specific methods

## Build Configuration

electron-builder targets:
- **Windows**: NSIS installer (requires admin for symlinks)
- **macOS**: DMG archive
- **Linux**: AppImage

Output goes to `dist/` folder with maximum compression and ASAR packaging.

## CI/CD

GitHub Actions (`.github/workflows/release.yml`) triggers on version tags (`v*`):
- Matrix build: Windows, Ubuntu, macOS
- Node 18 with npm cache
- Auto-uploads release assets
