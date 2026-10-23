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
  <img src="https://img.shields.io/badge/platform-Linux%20%7C%20macOS%20%7C%20Windows-blue.svg?style=flat-square" alt="Platform Linux | macOS | Windows" />
  <a href="https://ko-fi.com/joelmanisali"><img src="https://img.shields.io/badge/Ko--fi-Support%20Me-ff5e5b?style=flat-square&logo=ko-fi&logoColor=white" alt="Support on Ko-fi" /></a>
  <img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License MIT" />
</p>

---

## ✨ Features

- **⚡ Live Synced Karaoke**: Smooth, real-time scrolling lyrics that follow the exact playback progress of your music.
- **🎧 Zero Configuration Media Detection**: Automatically detects whatever is currently playing across Linux (MPRIS/D-Bus), macOS (AppleScript / Spotify / Apple Music), and Windows (SMTC / WinRT).
- **📜 Toggle Modes**:
  - **Live Sync**: Follows the active singing line with subtle auto-scroll and focus highlighting.
  - **Full Lyrics**: View complete lyrics in a clean scrollable list.
- **⏱️ Precision Offset Stepper**: Fine-tune lyric sync timing on the fly:
  - Click `[-]` / `[+]` for `±0.1s`.
  - Hold `[-]` / `[+]` to smoothly auto-repeat.
  - `Shift` + Click for rapid `±1.0s` jumps.
  - Mouse wheel scroll directly over the offset label for fast adjustments (`±0.5s` / `±1.0s`).
  - Click the offset value to instantly reset to `0.0s`.
  - Your custom offset is saved automatically across sessions.
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
4. Select **Install from VSIX...** and choose `orbit-lyrics-box-1.1.0.vsix`.
5. Open the **Lyrics Box** view from the Explorer sidebar or the Activity Bar icon.

---

## 🖥️ System Requirements & Cross-Platform Compatibility

Orbit Lyrics Box works seamlessly out of the box without requiring third-party background daemons:

- **Linux**:
  - Requires standard systemd `busctl` (installed by default on Ubuntu, Debian, Fedora, Arch, etc.).
  - Supported players: Chromium, Google Chrome, Brave, Edge, Spotify Desktop, VLC, Firefox.
- **macOS**:
  - Uses native macOS `osascript` (built into macOS).
  - Supported players: Spotify, Apple Music (Music.app).
- **Windows**:
  - Uses Windows Media Transport Controls (SMTC) via PowerShell WinRT (Windows 10 / 11).
  - Supported players: Spotify, Chrome, Edge, YouTube Music, iTunes, and any SMTC-enabled player.

---

## 🛠️ Development & Building

```bash
# Run unit tests
npm test

# Package to VSIX
npm run package
```

---

## ☕ Support the Project

If you find **Orbit Lyrics Box** useful and enjoy singing along to your favorite tunes while coding, please consider supporting its continued development:

<p align="center">
  <a href="https://ko-fi.com/joelmanisali" target="_blank">
    <img src="https://storage.ko-fi.com/cdn/kofi3.png?v=3" height="40" alt="Support Me on Ko-fi" />
  </a>
</p>

Every cup of coffee helps keep the lyrics synced and new features rolling. Thank you so much! ❤️

---

## 📄 License

MIT License. See [LICENSE.txt](./LICENSE.txt) for details.
