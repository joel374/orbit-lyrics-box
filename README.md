# Lyrics Box 🎵 (Live Karaoke Subtitle)

> Real-time synced lyrics & subtitle player widget for VS Code and Antigravity IDE. Automatically detects your active media playback (Chromium, Spotify, YouTube, etc.) and synchronizes karaoke lyrics directly inside your editor.

![Version](https://img.shields.io/badge/version-1.0.2-blue.svg)
![License](https://img.shields.io/badge/license-MIT-green.svg)
![Platform](https://img.shields.io/badge/platform-Linux-orange.svg)

---

## ✨ Features

- **⚡ Live Synced Karaoke**: Smooth, real-time scrolling lyrics that follow the exact playback progress of your music.
- **🎧 Zero Configuration Media Detection**: Automatically detects whatever is currently playing in your browser or desktop music player (Chromium, Chrome, Brave, Spotify, VLC, etc.) via Linux MPRIS/D-Bus.
- **📜 Toggle Modes**:
  - **Live Sync**: Follows the active singing line with subtle auto-scroll and focus highlighting.
  - **Full Lyrics**: View complete lyrics in a clean scrollable list.
- **⏱️ Precision Offset Stepper**: Fine-tune lyric sync timing on the fly (`-0.1s` / `+0.1s` buttons) or click to reset to `0.0s`. Your custom offset is saved automatically.
- **🎛️ Mini Player Controls**: Play, pause, previous track, next track, and progress bar scrubber right inside the sidebar.
- **💎 Apple Music-inspired Typography**: Sleek dark aesthetic with crisp fonts, rounded cards, and adaptive layouts for compact and expanded sidebars.

---

## 🚀 Getting Started

### Installation from `.vsix`
1. Download or package the `.vsix` file.
2. In VS Code or Antigravity IDE, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click the **`...`** (More Actions) menu at the top right of the Extensions panel.
4. Select **Install from VSIX...** and choose `orbit-lyrics-box-1.0.2.vsix`.
5. Open the **Lyrics Box** view from the Explorer sidebar or the Activity Bar icon.

---

## 🖥️ System Requirements & Compatibility

- **Operating System**: Linux (Ubuntu, Debian, Fedora, Arch, etc.) with `busctl` (standard on modern systemd Linux distributions).
- **Supported Players**: Any media player that publishes MPRIS2 metadata, including:
  - Chromium / Google Chrome / Brave / Microsoft Edge
  - Spotify Desktop
  - VLC Media Player
  - Firefox

---

## 🛠️ Development & Building

```bash
# Run unit tests
npm test

# Package to VSIX
npm run package
```

---

## 📄 License

MIT License. See [LICENSE.txt](./LICENSE.txt) for details.
