# Moonshot Miner 🚀

Read in [English](README.md) | [中文](README.zh-TW.md)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-1.0.6-green.svg)
![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey.svg)

> **Note**: This project was built through **Vibe Coding** with [Google DeepMind's Antigravity](https://deepmind.google/).  
> This project was born from human-AI collaboration (Vibe Coding), showcasing the joy and possibilities of co-development.

Moonshot Miner is a lightweight, cross-platform Bitcoin solo miner built with Electron. Designed to run discreetly in the background, it resides in your system tray and connects directly to `solo.ckpool.org`, attempting to mine Bitcoin blocks using your CPU.

![Screenshot](icon.png)

## ✨ Features

*   **Real Stratum Protocol**: Directly connects to `solo.ckpool.org:3333`, fully adhering to the Stratum mining protocol.
*   **System Tray Integration**: Runs quietly in the background. Click the tray icon to show or hide the status window.
*   **Floating Status Window**: A frameless, semi-transparent, always-on-top window for easy monitoring.
*   **Dynamic Resizing**: The window height adjusts automatically based on content (expanding for settings, shrinking for minimal mode).
*   **Minimal Mode**: A "stealth" mode that hides the title and fluctuating hashrate, executing in a tiny footprint (~130px height) while showing only status.
*   **System Notifications**: Get notified via native Windows notifications if you're lucky enough to find a valid Share (or Block!) 🎉.
*   **Auto Mine**: Can be configured to start mining automatically upon application launch if a wallet address is set.
*   **Run on Startup**: Supports launching automatically with Windows (requires packaging as .exe to work effectively).

## 🛠 Prerequisites

*   Node.js (v14 or higher)
*   npm

## 📦 Installation

```bash
# Enter project directory
cd d:\side_project\moonshot

# Install dependencies
npm install
```

## 🚀 Usage

### Development Mode
Start the application locally for development or testing:

```bash
npm start
```
*   **Settings**: Click the gear ⚙️ icon to open the settings panel.
*   **Wallet**: Enter your Bitcoin (BTC) wallet address (e.g., `162e2cFD2RRYHhvsb3bGthPzYefnXT83s9`).
*   **Intensity**: Adjust the sleep time between hash operations (Higher value = Lower CPU usage).

### Build / Packaging
Package the application into a standalone `.exe` installer (Windows):

```bash
# Method 1: Use helper script (Recommended, requests admin privileges automatically)
.\build_helper.bat

# Method 2: Manual command (Ensure terminal is run as Administrator)
npm run dist
```
After building, the installer will be generated in the `dist/` folder (e.g., `Moonshot Miner Setup 1.0.0.exe`).
*   **Note**: Window packaging requires creating symbolic links, which **requires Administrator privileges**. Use the methods above if you encounter `Cannot create symbolic link` errors.
*   **Note**: The "Run on Startup" feature works best after installing the `.exe`.

### macOS & Linux
To package for macOS or Linux, it is recommended to run the build command natively on that system:

```bash
npm run dist
```
*   **macOS**: Generates `.dmg` or `.app`.
*   **Linux**: Generates `.AppImage`.
> **Note**: Cross-platform packaging (e.g., building Linux on Windows) may require complex Docker setups or WSL. It is simplest to build on the target OS.

## ⚙️ Settings

Click the gear ⚙️ icon in the top-right corner to open the settings panel:

| Setting | Description | Default |
| :--- | :--- | :--- |
| **Wallet Address** | Your Bitcoin (BTC) wallet address. Proceeds are paid directly here. | (Empty) |
| **Intensity** | **Mining Intensity** (Sleep time in ms).<br>Lower value = Faster speed (High CPU).<br>Higher value = Slower speed (Low CPU). | `100` |
| **Minimal Mode** | **Stealth Mode**. Hides title and hashrate, showing only connection status in a minimized window (~130px height). Ideal for background running. | Off |
| **Auto Start** | **Auto Mine**. Automatically starts mining on launch if a wallet address is configured. | Off |
| **Open At Login** | **Run on Startup**. Launch program automatically when Windows logs in (Recommended for use with installed .exe). | Off |

### Config File Location
All user settings are stored locally in `config.json`:
*   `C:\Users\{username}\AppData\Roaming\MoonshotMiner\config.json`

## ⚠️ Disclaimer

This application uses **CPU Mining**. At current network difficulties, the probability of finding a Bitcoin block (or even a share in a high-diff pool like ckpool) with a CPU is **astronomically low**. To put it bluntly, it's roughly equivalent to **"winning the lottery jackpot twice in a row"**.

This project is primarily for educational purposes and to experience the thrill of a "Moonshot" — keeping that tiny, non-zero dream of hitting the jackpot alive, just like buying a lottery ticket.

## 🐛 Troubleshooting

*   **Window Glitches**: If the window size gets stuck or displays incorrectly, try toggling the settings panel or restarting the app.
*   **GPU Cache Error**: Statistics warnings about GPU cache in the terminal are common Electron warnings on some Windows systems and can usually be ignored.

---
*Built with ❤️ by Antigravity & User (Vibe Coding)*
