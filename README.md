# Omnex

A local-first desktop AI assistant: text + voice chat with a 3D VRM avatar,
running as an Electron app on your PC. Local LLM by default (via Ollama),
cloud API as an automatic fallback if the local model isn't reachable.

## Features

- **Text mode** — normal chat window.
- **Voice mode** — hold the mic button and talk. Two speech-to-text engines:
  - *Browser* (Web Speech API) — zero setup, needs internet the first time
    Chrome downloads its recognition model, works offline after that on most
    systems.
  - *Offline (Whisper)* — fully private, routes audio to a local
    `whisper.cpp` server you run yourself. See setup below.
  - Text-to-speech uses the OS/browser's built-in voices (offline).
- **3D avatar** — loads any `.vrm` anime-style model, idle sway + blink, and
  lip-syncs while Omnex speaks.
- **Brain selector (BYOK)** — Local (Ollama), Cloud (your own API key), or
  Auto (local first, cloud if Ollama isn't running). Cloud mode means low-end
  PCs need no model download at all.

## 1. Install

```bash
cd omnex
npm install
```

## 2. Set up the local brain (Ollama)

1. Install Ollama: https://ollama.com/download
2. Pull a model:
   ```bash
   ollama pull llama3.1
   ```
3. Ollama runs its own local server at `http://127.0.0.1:11434` automatically
   — nothing else to start.

Omnex's default settings already point at this model/URL. Change them in the
in-app **Settings (⚙)** panel if you use a different model name.

## 3. Choose your brain (local, cloud, or auto)

Pick where Omnex thinks with the **Auto / Local / Cloud** switch in the top
bar (or in Settings → Brain):

| Mode | What happens | Best for |
|------|--------------|----------|
| **Local** | Only your Ollama model is used. Nothing leaves your PC. | Good hardware, privacy |
| **Cloud** | Only your own API key is used. No model download, no GPU. | **Low-end PCs** |
| **Auto** | Ollama first; if it isn't running, uses your cloud key. | Laptops that come and go |

**Bring your own key (BYOK):** open Settings (⚙) → Cloud, pick a provider
(Anthropic, OpenAI, OpenRouter, Groq, or any OpenAI-compatible endpoint via
*Custom*), paste your key, and press **Test key**. Keys are saved per provider,
encrypted with your OS keychain when available, and are never sent back to the
UI. You pay your provider directly for what you use. In Cloud mode (and in
Auto when it falls back), your messages are sent to that provider.

Model names change over time; if a model is rejected, type a current one into
the Model field.

## 4. (Optional) Offline voice with Whisper

Browser voice mode works with no setup. For fully offline transcription:

1. Build `whisper.cpp` with its server example:
   ```bash
   git clone https://github.com/ggml-org/whisper.cpp
   cd whisper.cpp && make
   sh ./models/download-ggml-model.sh base.en
   ./build/bin/whisper-server -m models/ggml-base.en.bin --port 8080
   ```
2. In Omnex, switch the voice-mode dropdown to **Offline voice (Whisper)**
   and confirm the server URL in Settings matches (default
   `http://127.0.0.1:8080`).

## 5. Add your 3D avatar

Drop a `.vrm` file into `assets/models/` named `omnex.vrm`. See
`assets/models/PUT_YOUR_VRM_HERE.txt` for free places to get or make one
(VRoid Studio is the easiest — free desktop app, export straight to `.vrm`).

## 6. Run it

```bash
npm start
```

## 7. Build the Windows .exe / .msi

**Locally (on Windows):**
```bash
npm run dist:win
```
Installers appear in `dist/` (`Omnex-<version>-Setup.exe` and `.msi`).

**On GitHub (no Windows PC needed):**
1. Push this folder to a GitHub repo.
2. Go to **Actions → Build Omnex → Run workflow**, or publish a release by
   pushing a version tag:
   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```
3. When the run finishes, download the files from the run's **Artifacts**
   (or from the repo's **Releases** page if you pushed a tag).

The installers are unsigned, so Windows SmartScreen will show a warning
("More info" → "Run anyway") until you add a code-signing certificate.
Remember to commit your `assets/models/omnex.vrm` (only if its license allows
redistribution), otherwise the installed app starts without an avatar.

## Project structure

```
omnex/
  main.js         Electron main process: window, settings storage, LLM routing
  preload.js      Safe IPC bridge (contextBridge)
  src/
    index.html    App shell / layout
    styles.css    HUD visual design
    renderer.js   Wires UI + avatar + voice + conversation together
    avatar.js     Three.js + VRM loader, idle motion, lip sync
    voice.js      Speech recognition/synthesis + Whisper client + mic metering
    llm.js        Conversation history manager
  assets/models/  Put your omnex.vrm here
```

## Notes & next steps

- Lip sync uses an approximated mouth-open envelope timed to speech
  boundaries, since browser `speechSynthesis` doesn't expose raw audio for
  analysis. For frame-accurate sync, swap in a local TTS engine that returns
  an audio buffer (e.g. Piper) and drive the VRM `aa` blendshape from real
  amplitude — the hook is `stage.setSpeaking(level)` in `renderer.js`.
- The reticle ring around the avatar visualizes mic input level while
  listening; wire `stage.setSpeaking()` in from `mediaRecorder` output too if
  you want the same ring to pulse while Omnex talks.
- All settings are stored locally via `electron-store` (plain JSON in your
  OS's app-data folder) — the cloud API key never touches version control or
  leaves your machine except in the direct API call.
