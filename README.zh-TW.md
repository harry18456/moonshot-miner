# Moonshot Miner 🚀

Read in [English](README.md) | [中文](README.zh-TW.md)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Version](https://img.shields.io/badge/version-1.0.6-green.svg)
![Platform](https://img.shields.io/badge/platform-win%20%7C%20mac%20%7C%20linux-lightgrey.svg)


> **Note**: This project was built through **Vibe Coding** with [Google DeepMind's Antigravity](https://deepmind.google/).  
> 這是一個透過與 AI 協作 (Vibe Coding) 所誕生的專案，展現了人機協作開發的樂趣與可能性。

Moonshot Miner 是一個使用 Electron 建構的輕量級、跨平台比特幣 Solo 挖礦應用程式。它的設計目的是在背景低調運行，常駐於系統列，並直接連接到 `solo.ckpool.org`，嘗試使用您的 CPU 來挖掘比特幣區塊。

![Screenshot](icon.png)

## ✨ 功能特色

*   **真實 Stratum 協議實作**：直接連接到 `solo.ckpool.org:3333`，完全遵循 Stratum 挖礦協議運作。
*   **系統列整合 (System Tray)**：程式會在背景運行。點擊與系統列的小圖示可顯示或隱藏狀態視窗。
*   **懸浮狀態視窗**：無邊框、半透明、最上層顯示 (Always-on-top) 的視窗，方便您隨時監控狀態。
*   **動態視窗縮放**：視窗高度會根據內容自動調整（精簡模式、設定展開時會自動變高或變矮）。
*   **精簡模式 (Minimal Mode)**：一種「隱形」模式，隱藏標題與跳動的算力數字，只佔用極小的螢幕空間 (~130px 高)，僅顯示挖礦狀態。
*   **系統通知**：如果幸運挖到有效的 Share (或區塊)，會發送 Windows 系統通知提醒您 🎉。
*   **自動挖礦 (Auto Mine)**：可設定程式啟動後，只要有錢包地址就自動開始挖礦。
*   **開機自動啟動 (Run on Startup)**：可設定隨 Windows 開機自動執行程式 (需要打包成 .exe 後才有效)。

## 🛠 前置需求

*   Node.js (v14 或更高版本)
*   npm

## 📦 安裝教學

```bash
# 進入專案目錄 (如果需要)
cd d:\side_project\moonshot

# 安裝相依套件
npm install
```

## 🚀 使用說明

### 開發模式 (Development)
在本地端啟動應用程式進行開發或測試：

```bash
npm start
```
*   **設定**：點擊齒輪 ⚙️ 圖示打開設定面板。
*   **錢包**：輸入您的比特幣 (BTC) 錢包地址 (例如：`162e2cFD2RRYHhvsb3bGthPzYefnXT83s9`)。
*   **強度 (Intensity)**：調整雜湊運算之間的休眠時間 (數值越高 = CPU 使用率越低)。

### 打包發布 (Build / Packaging)
將應用程式打包成獨立的 `.exe` 安裝檔 (Windows)：

```bash
# 方法一：使用內建腳本 (推薦，會自動請求管理員權限)
.\build_helper.bat

# 方法二：手動指令 (請確保您的終端機是以「系統管理員身分」執行)
npm run dist
```
打包完成後，安裝檔會產生在 `dist/` 資料夾中 (例如 `Moonshot Miner Setup 1.0.0.exe`)。
*   **注意**：Windows 打包過程需要建立符號連結 (Symbolic Link)，**必須擁有系統管理員權限**才能成功。如遇到 `Cannot create symbolic link` 錯誤，請使用上述方法。
*   **注意**：「開機自動啟動」功能建議在安裝 `.exe` 後使用，效果最佳。

### macOS & Linux
若要在 macOS 或 Linux 上打包，建議直接在該系統環境下執行：

```bash
npm run dist
```
*   **macOS**：預設會產生 `.dmg` 或 `.app`。
*   **Linux**：預設會產生 `.AppImage`。
> **Note**: 若需進行跨平台打包 (例如在 Windows 上打包 Linux 版)，可能需要額外的 Docker 配置或 WSL 環境，建議直接在目標系統上編譯最為單純。

## ⚙️ 詳細設定 (Settings)

點擊主介面右上角的齒輪 ⚙️ 圖示即可開啟設定面板，包含以下選項：

| 設定項目 | 說明 | 預設值 |
| :--- | :--- | :--- |
| **Wallet Address** | 您的比特幣 (BTC) 錢包地址。挖到的收益將直接支付至此地址。 | (空) |
| **Intensity** | **挖礦強度** (數值為休眠毫秒數)。<br>數值 **越小** = 速度越快 (耗 CPU)。<br>數值 **越大** = 速度越慢 (省 CPU)。 | `100` |
| **Minimal Mode** | **精簡模式**。開啟後隱藏標題與算力，只顯示連線狀態，並將視窗縮至最小 (~130px 高)，適合掛機使用。 | 關閉 |
| **Auto Start** | **自動開始挖礦**。程式啟動後，若已設定錢包地址，將自動開始連線挖礦。 | 關閉 |
| **Open At Login** | **開機自動啟動**。設定 Windows 登入時是否自動執行此程式 (建議安裝 .exe 後使用)。 | 關閉 |

### 設定檔儲存位置
所有使用者設定皆儲存於本地端的 `config.json` 檔案中：
*   `C:\Users\{使用者名稱}\AppData\Roaming\MoonshotMiner\config.json`

## ⚠️ 免責聲明 (Disclaimer)

本應用程式使用 **CPU 挖礦**。在現今的難度下，使用 CPU 找到比特幣區塊 (甚至是在像 ckpool 這樣的高難度礦池找到一個 Share) 的機率，講白了大概跟 **「連續中兩次樂透頭獎」** 差不多。本專案主要用於教育用途，以及體驗那種「Moonshot (射月)」—— 雖然機率渺茫，但就像買彩券一樣，總是保留著那一絲絲中大獎的夢想與樂趣。

## 🐛 疑難排解

*   **視窗異常**：如果視窗大小卡住或顯示異常，請嘗試切換設定面板或重啟程式。
*   **GPU Cache 錯誤**：在終端機中若看到 GPU cache warning，這是 Electron 在部分 Windows 系統上的常見警告，通常無害可忽略。

---
*Built with ❤️ by Antigravity & User (Vibe Coding)*
