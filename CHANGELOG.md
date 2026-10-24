# Changelog

All notable changes to the "Orbit Lyrics Box" extension will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.1] - 2026-10-24

### Fixed
- **Windows Media Detection**: Resolved an issue where Windows 10/11 media players (Spotify, Chrome, Edge) were stuck in a loading state due to WinRT async resolution.
- **Multi-Session Active Fallback**: When VS Code is focused, the Windows session manager now automatically inspects all active media sessions (`GetSessions`) to track playing music seamlessly.
- **Spotify Desktop Window Fallback**: Added a process-level window title fallback for Spotify Desktop on Windows when SMTC metadata is delayed.
- **PowerShell Execution & Throttling**: Added `-ExecutionPolicy Bypass` and a 900ms query cache to minimize CPU usage and prevent security policy blocking on Windows.

---

## [1.1.0] - 2026-10-23

### Added
- **Cross-Platform Support**:
  - **macOS**: Native AppleScript integration for Spotify and Apple Music (`Music.app`) with seeking support.
  - **Windows**: Windows Media Transport Controls (SMTC) integration for Chrome, Spotify, Edge, and media players.
- **Advanced Offset Stepper**:
  - Smooth auto-repeat on button hold.
  - `Shift` + Click for rapid `±1.0s` adjustments.
  - Mouse wheel scrolling over offset label (`±0.5s` standard, `±1.0s` with Shift).
  - Keyboard accessibility support (`Enter` / `Space`).
- **Support & Funding**: Added official Ko-fi badge and metadata.

### Fixed
- **Synced Lyrics Priority**: Fixed an issue where plain text lyrics were chosen over available synced lyrics when tags were inverted.
- **Artist Name Variance**: Enhanced candidate matching for full artist names (e.g. "Adele Adkins" vs "Adele").
- **Version Bracket Discrepancy**: Allowed matching for candidate tracks with version tags like `(Unreleased)` when audio duration matches.

---

## [1.0.4] - 2026-10-15

### Added
- Real-time synced lyrics & subtitle player widget for VS Code and Antigravity IDE.
- Zero-config media playback detection via Linux MPRIS / D-Bus (`busctl`).
- Live Karaoke Sync and Full Lyrics scrolling modes.
- Mini player playback controls (Play, Pause, Previous, Next, Seek Scrubber).
- Custom font size and text alignment settings.
