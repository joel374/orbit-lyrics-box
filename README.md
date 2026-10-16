<p align="center">
  <img src="media/icon.png" width="128" height="128" alt="Orbit Lyrics Box Logo" />
</p>

# Lyrics Box 🎵 (Live Karaoke Subtitle)

> Real-time synced lyrics & subtitle player widget for VS Code and Antigravity IDE. Automatically detects your active media playback (Chromium, Spotify, YouTube, etc.) and synchronizes karaoke lyrics directly inside your editor.

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=JoelManisali.orbit-lyrics-box"><img src="https://img.shields.io/visual-studio-marketplace/v/JoelManisali.orbit-lyrics-box?style=flat-square&color=blue&label=VS%20Code%20Marketplace" alt="Marketplace Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=JoelManisali.orbit-lyrics-box"><img src="https://img.shields.io/visual-studio-marketplace/i/JoelManisali.orbit-lyrics-box?style=flat-square&color=success&logo=visual-studio-code" alt="Marketplace Installs" /></a>
  <a href="https://open-vsx.org/extension/JoelManisali/orbit-lyrics-box"><img src="https://img.shields.io/open-vsx/v/JoelManisali/orbit-lyrics-box?style=flat-square&color=purple&label=Open%20VSX" alt="Open VSX Version" /></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=JoelManisali.orbit-lyrics-box"><img src="https://img.shields.io/visual-studio-marketplace/r/JoelManisali.orbit-lyrics-box?style=flat-square&color=orange" alt="Marketplace Rating" /></a>
  <img src="https://img.shields.io/badge/platform-Linux-orange.svg?style=flat-square" alt="Platform Linux" />
  <img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License MIT" />
</p>

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
- **⚙️ Customizable Settings**: Adjust lyric font size (`small`, `medium`, `large`) and alignment (`center`, `left`) directly in VS Code settings.

---

## ⚙️ Configuration

You can customize Orbit Lyrics Box via **Settings** (`Ctrl+,`):

| Setting | Default | Options | Description |
|---|---|---|---|
| `orbitLyrics.fontSize` | `medium` | `small`, `medium`, `large` | Adjust lyric font typography size |
| `orbitLyrics.alignment` | `center` | `center`, `left` | Text alignment for karaoke lyrics |

## 🚀 Getting Started

### Installation from `.vsix`
1. Download or package the `.vsix` file.
2. In VS Code or Antigravity IDE, open the Extensions view (`Ctrl+Shift+X` / `Cmd+Shift+X`).
3. Click the **`...`** (More Actions) menu at the top right of the Extensions panel.
4. Select **Install from VSIX...** and choose `orbit-lyrics-box-1.0.4.vsix`.
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
