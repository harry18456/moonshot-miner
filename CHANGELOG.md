# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.2] - 2026-10-17

### Fixed
- Preserve zero-millisecond mining intensity in the worker and settings UI.
- Apply pool difficulty changes to the next job and preserve fractional target precision.
- Cancel stale mining callbacks after reconnects and replace work even when job IDs are reused.
- Continue nonce searches without random restarts and support full-width extraNonce2 rollover.
- Distinguish submitted, accepted, and rejected shares while keeping worker controls available.

### Changed
- Use the current CKPool Stratum endpoint and request share difficulty 1 after authorization.
- Add protocol, share reconstruction, reconnect, nonce rollover, and renderer regression tests.
- Exclude local agent settings from application installers.

## [1.0.7] - 2026-01-09

### Changed
- **Optimized Build Size**: Reduced installer size by ~77% (from >400MB to ~96MB) by excluding development files.
- **UI Fix**: Adjusted intensity slider to allow setting full range (0-1000ms), fixing the off-by-one error.
- **Repository Name**: Updated project metadata to `moonshot-miner`.

## [1.0.6] - 2026-01-09

### Added
- **Cross-Platform Support**: Detailed build instructions for macOS and Linux.
- **MIT License**: Open-sourced the project under the MIT License.
- **English README**: Added full English documentation and language toggle.
- **Community Standards**: Added CONTRIBUTING.md, CODE_OF_CONDUCT.md, and SECURITY.md.
- **Vibe Coding Attribution**: Acknowledged the AI-assisted development process.

### Changed
- Refined `README.md` with detailed settings documentation and a more colloquial probability disclaimer.
- Improved `.gitignore` patterns for better development hygiene.

## [1.0.0] - 2026-01-09

### Added
- **Solo Mining**: Real Stratum protocol implementation for solo.ckpool.org.
- **UI**: Frameless, always-on-top floating window with minimal mode.
- **System Tray**: Background operation with tray icon control.
- **Notifications**: Native system notifications for found shares/blocks.
- **Auto-Start**: Options for mining on startup and auto-launching at login.
