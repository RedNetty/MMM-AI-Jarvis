# MMM-AI-Jarvis (IRIS)

A local voice assistant and outfit planner module for [MagicMirror²](https://magicmirror.builders/).

![Node](https://img.shields.io/badge/node-%3E%3D20.3-339933) ![MagicMirror](https://img.shields.io/badge/MagicMirror%C2%B2-%3E%3D2.20-blue)

The assistant is called IRIS (Image Recognition & Intelligent Speech). You say "Iris" followed by a question, and it answers out loud and shows the result on the mirror as a card: weather, stock charts, news, live sports scores, timers, or an outfit picked from your own wardrobe for the forecast. It can also rearrange the rest of the mirror by voice and look at you through a camera.

Speech recognition (whisper.cpp), the language and vision model (Ollama) and the voice (Kokoro, Piper or espeak-ng) all run on your own hardware. There are no cloud accounts or API keys. The module folder is still named `MMM-AI-Jarvis` so existing installs keep working.

<p align="center"><img src="docs/demo.gif" width="360" alt="IRIS answering on a MagicMirror with weather, market and news cards"></p>

## Features

- Hands-free wake word, follow-up questions without repeating it, and "stop" to interrupt
- Animated cards for weather, stocks and crypto, news, facts, definitions, currency, maths, world clocks, countdowns and sunrise/sunset, using free public sources
- Live scores and schedules from ESPN for the NFL, NBA, MLB, NHL and major soccer leagues
- Wardrobe catalogue built from camera photos, and outfit suggestions based on the weather, occasion and what you wore recently
- Voice control of the whole mirror: move, resize, hide, dim, night mode, screen off and saved layouts
- Morning briefing, rain alerts and kick-off/final-score alerts for your teams
- Long-term memory of preferences ("remember that my office is business casual")
- Failover between model servers, so a Raspberry Pi mirror can use a Mac on the network and fall back to itself

## How it works

```
microphone -> voice activity detection -> whisper.cpp -> wake word
                                                            |
                         fast intents (time, weather, scores, timers, outfits, display, memory)
                                                            |
                           router (only on fast servers): picks a skill for free-form requests
                                                            |
                    Ollama (qwen3.5) <- Wikipedia extracts / fresh headlines for grounding
                                                            |
                       mirror cards (written form)    speaker: Kokoro / Piper / espeak-ng
```

Common requests are handled by deterministic intents and a rule-based outfit planner, which answer in milliseconds and do not depend on the language model. Everything else goes to the model, which can call the same tools. Only the tools relevant to a request are included in the prompt, which keeps prompts small enough to be usable on a Raspberry Pi CPU.

Replies are written the way a person speaks, and a normalizer rewrites times, game clocks, dates and units before they reach the voice ("7:00 PM" is spoken as "seven p.m."). The mirror still shows the written form. While IRIS is speaking, anything it hears needs the wake word, so it does not answer its own voice.

## Screenshots

Captured from the module running in MagicMirror 2.38. More in [`docs/features`](docs/features), and every state in [`docs/ui-gallery.png`](docs/ui-gallery.png).

| | | |
|---|---|---|
| ![Outfit](docs/features/02-outfit.png)<br>"What should I wear to dinner tonight?" | ![Weather](docs/features/03-weather.png)<br>"What's the weather like tonight?" | ![Games on now](docs/features/14-games-on-now.png)<br>"What games are on right now?" |
| ![Briefing](docs/features/15-briefing.png)<br>"Good morning" | ![Stock](docs/features/18-stock.png)<br>"How is Nvidia stock doing?" | ![News](docs/features/19-news.png)<br>"What's the news?" |
| ![Timer](docs/features/06-timer.png)<br>"Set a pasta timer for 10 minutes" | ![Scanning](docs/features/09-camera-scanning.png)<br>"Add these clothes to my wardrobe" | ![Added](docs/features/10-wardrobe-added.png)<br>Wardrobe items with photo crops |
| ![Knowledge](docs/features/20-knowledge.png)<br>"Who is Taylor Swift?" | ![Time zones](docs/features/12-time-zones.png)<br>"What time is it in Tokyo?" | ![Move and resize](docs/features/26-move-resize.png)<br>"Move the clock to the top right" |

## Requirements

- MagicMirror² 2.20 or newer (tested on 2.38.0, which needs Node.js 22.22.2 or newer)
- A 64-bit OS: Raspberry Pi OS Bookworm or newer, Debian/Ubuntu, or macOS on Apple Silicon
- A USB microphone and a speaker
- Optional: a Raspberry Pi camera or USB webcam for the wardrobe and "how do I look" features

Recommended hardware:

| Setup | Model | Voice |
|---|---|---|
| Apple Silicon Mac driving the mirror | `qwen3.5:4b` | Kokoro |
| Raspberry Pi mirror with a Mac on the network as the "brain" | `qwen3.5:4b` on the Mac, `qwen3.5:2b` on the Pi | Kokoro, falling back to Piper |
| Raspberry Pi 5 (4 or 8 GB) on its own | `qwen3.5:2b` | Piper |
| Raspberry Pi 4 (8 GB) | `qwen3.5:2b` | Piper, noticeably slower for open questions |

On a CPU-only machine the intent-based answers (time, timers, outfits, scores) stay near instant. Open questions that go to the language model take a few seconds to start speaking, and camera features take much longer. Running the model on an Apple Silicon Mac is the biggest speed-up.

## Installation

### 1. Get the module

```bash
cd ~/MagicMirror/modules
git clone https://github.com/RedNetty/MMM-AI-Jarvis.git
```

There are no npm dependencies.

### 2. Install the speech and model servers (Raspberry Pi / Debian)

```bash
cd ~/MagicMirror/modules/MMM-AI-Jarvis
scripts/setup-pi.sh
```

The script installs Ollama with a model sized to your RAM, builds whisper.cpp, installs Piper, and runs whisper.cpp (port 8178) and Piper (port 5005) as the `iris-whisper` and `iris-piper` systemd services. The first run compiles whisper.cpp and downloads a few GB of models. At the end it plays a test phrase and prints a config block to paste.

| Option | Effect |
|---|---|
| `--model qwen3.5:4b` | Use a different Ollama model |
| `--voice en_GB-alan-medium` | Use a different Piper voice |
| `--whisper-model base.en` | Larger Whisper model (`tiny` for non-English languages) |
| `--brain macbook.local` | Use a Mac on the network first (see below) |
| `--no-ollama`, `--no-whisper`, `--no-piper` | Skip a component |
| `--whisper-port`, `--piper-port` | Change the service ports |

### 3. Add it to `config/config.js`

```js
{
  module: "MMM-AI-Jarvis",
  position: "lower_third",
  config: {
    userName: "Alex",
    llm: { model: "qwen3.5:2b" },
    weather: { latitude: 40.71, longitude: -74.01 }, // optional, enables hourly forecasts
  },
},
```

The defaults match the setup script. Restart MagicMirror and say "Iris, what should I wear today?". If a service is not reachable, IRIS shows the problem on the mirror and keeps re-checking, so services that start after MagicMirror at boot are picked up.

## Running on a Mac

An Apple Silicon Mac runs the model and Whisper on its GPU and is fast enough for the Kokoro voice. A MacBook with a broken screen works fine, since it never needs its own display.

**The Mac as the mirror computer:**

```bash
git clone https://github.com/MagicMirrorOrg/MagicMirror ~/MagicMirror
cd ~/MagicMirror && npm run install-mm
git clone https://github.com/RedNetty/MMM-AI-Jarvis.git modules/MMM-AI-Jarvis
modules/MMM-AI-Jarvis/scripts/setup-mac.sh
```

Add the printed config block, then start the mirror from `~/MagicMirror` with `./node_modules/.bin/electron js/electron.js` (MagicMirror's `npm run start` adds Linux-only flags). macOS will ask for microphone and camera permission on first use.

**The Mac as the brain for a Pi mirror:**

```bash
# on the Mac
scripts/setup-mac.sh --share

# on the Pi
scripts/setup-pi.sh --brain macbook.local
```

The Pi config then lists the Mac first and itself as a fallback:

```js
stt: { whisperUrl: ["http://macbook.local:8178", "http://127.0.0.1:8178"] },
tts: { kokoroUrl: "http://macbook.local:5006", piperUrl: "http://127.0.0.1:5005" },
llm: {
  servers: [
    { url: "http://macbook.local:11434", model: "qwen3.5:4b" },
    { url: "http://127.0.0.1:11434", model: "qwen3.5:2b" },
  ],
},
```

Servers are health-checked in the background, so if the Mac is asleep requests go straight to the Pi without waiting for timeouts.

`setup-mac.sh` installs Ollama, ffmpeg, whisper.cpp (with Metal), Kokoro and Piper via Homebrew and runs them as LaunchAgents (logs in `~/Library/Logs/iris-*.log`). It also keeps the Mac awake with `pmset`; pass `--keep-sleep` to skip that, or undo it with `sudo pmset -a disablesleep 0`. Other options: `--kokoro-voice <name>`, `--no-kokoro`, `--model`, `--whisper-model`, `--voice`. The services have no authentication, so only use `--share` on a network you trust.

Any other machine with a GPU can also serve the model: run Ollama with `OLLAMA_HOST=0.0.0.0` and add it to `llm.servers`. `scripts/kokoro_server.py` runs on Linux and Windows too.

## Usage

Start with "Iris" (or "Hey Iris"). After an answer you have a few seconds to follow up without the wake word. Some examples:

```text
What time is it in London?            How long until Christmas?
What should I wear to dinner tonight? Do I need an umbrella?
What games are on right now?          When do Arsenal play?
How's the stock market doing?         Compare Apple and Microsoft
Convert 100 dollars to euros          What's 17% of 240?
Set a pasta timer for 12 minutes      Put a packing list for the beach on the mirror
Remember that my office is business casual
```

### Wardrobe

Hold one to three items up to the camera and say "Iris, add these to my wardrobe". IRIS photographs them and records each item's name, category, colours, material, formality, warmth and season. You can also add items by voice ("add my black leather boots to my wardrobe"), correct them ("change the grey hoodie to warmth 4"), and say "I'm wearing that" after a suggestion so it is not repeated the next day.

The wardrobe is stored as plain JSON in `data/wardrobe.json`, with photos in `data/photos/`.

### Controlling the mirror

<p align="center"><img src="docs/director.gif" width="300" alt="IRIS moving and resizing modules, night mode and screen off"></p>

IRIS knows which modules are on the mirror, so you can say "move the calendar to the top right", "make the clock bigger", "the text is too small", "dim the mirror", "night mode", "turn the screen off", "where's the calendar?", "save this layout as morning" or "reset the layout". Changes are applied in the browser and saved to `data/layout.json`; `config.js` is never modified. Hiding and showing use MagicMirror's lock mechanism, so it works alongside modules such as MMM-pages.

Modules listed in `display.autoHide` (default `compliments`) fade out while IRIS is showing something. You can also map phrases to notifications for other modules:

```js
customCommands: [
  { phrases: ["next page"], notification: "PAGE_INCREMENT", reply: "Next page." },
  { phrases: ["screen off"], notification: "REMOTE_ACTION", payload: { action: "MONITOROFF" } },
],
```

## Configuration

Every option is optional, and nested sections are merged with the defaults, so `llm: { model: "qwen3.5:4b" }` keeps the other `llm` settings. [`config/config.js.sample`](config/config.js.sample) documents every option. The ones you are most likely to change:

| Option | Default | Description |
|---|---|---|
| `wakeWord` / `wakeWordAliases` | `"iris"` / `["aris","irus","iras","eyeris"]` | Wake word and mis-hearings that also count |
| `userName` | `""` | Used to personalise replies |
| `language` | `"en"` | Whisper language (other languages need a multilingual model) |
| `dataDir` | `"data"` | Wardrobe, memory, layouts and photos |
| `stt.whisperUrl` | `"http://127.0.0.1:8178"` | whisper.cpp server, or a list for failover |
| `tts.provider` | `"auto"` | `auto` (Kokoro, then Piper, then espeak-ng), `kokoro`, `piper` or `espeak` |
| `tts.kokoroUrl` / `tts.piperUrl` | `""` / `"http://127.0.0.1:5005"` | Voice servers (empty Kokoro URL means port 5006 on this machine) |
| `llm.servers` | `[]` | Ollama servers in order of preference, each `{ url, model }` |
| `llm.ollamaUrl` / `llm.model` | `"http://127.0.0.1:11434"` / `"qwen3.5:2b"` | Used when `servers` is empty |
| `llm.router` | `"auto"` | Model-based skill routing: `auto` (only on fast servers), `true` or `false` |
| `llm.outfitPlanner` | `"fast"` | `fast` (rule-based) or `ai` (model chooses, slower) |
| `audio.micDevice` / `audio.speakerDevice` | `"default"` | ALSA device on Linux, device name or index on macOS; `"none"` disables the mic |
| `audio.vadThreshold` | `500` | Raise if background noise triggers IRIS |
| `audio.silenceMs` / `audio.pauseMs` | `750` / `300` | End-of-sentence pause, and early transcription pause |
| `camera.enabled` / `camera.tool` | `true` / `"auto"` | `rpicam-still`, `libcamera-still`, `fswebcam`, `ffmpeg` or `custom` |
| `weather.latitude` / `weather.longitude` | `null` | Use Open-Meteo directly; otherwise IRIS reads MagicMirror's `weather` module |
| `sports.leagues` / `sports.favorites` | 10 leagues / `[]` | Leagues to search, and your teams for alerts and briefings |
| `info.enabled` | `true` | Wikipedia, news, markets, currency and definitions; `false` turns them off |
| `search.searxngUrl` | `""` | Optional self-hosted SearXNG instance |
| `proactive.quietHours` | `[22, 7]` | Alerts are shown but not spoken |
| `display.maxWidgets` | `4` | Cards on screen at once |
| `debug` | `false` | Log transcripts and timings |

## Notifications

| Notification | Direction | Payload |
|---|---|---|
| `IRIS_ASK` | received | `"text"` or `{ text }`; asks a question without the wake word |
| `IRIS_STOP` | received | Stops speaking and cancels the request |
| `USER_PRESENCE` | received | `true` / `false` from a presence sensor module |
| `IRIS_STATE` | sent | `{ state }`: `idle`, `listening`, `processing` or `speaking` |
| `IRIS_RESPONSE` | sent | `{ text }` for every answer |
| `IRIS_TIMER_DONE` | sent | `{ label }` |

The older `JARVIS_ASK` and `JARVIS_STOP` names are still accepted.

## Privacy

Audio is processed in memory and never written to disk. The camera is only used when a request needs it, and only photos of clothing added to the wardrobe are saved. The only outbound requests fetch public data (ESPN, Open-Meteo, Wikipedia, Google News RSS, Yahoo Finance, Frankfurter, dictionary APIs) and send the topic, not your audio, images or the wording of your question. Delete `data/` to remove everything IRIS has stored.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Cannot reach Ollama" on the mirror | `systemctl status ollama`, and check `llm.ollamaUrl` |
| "Ollama model ... is not installed" | `ollama pull <model>` |
| "Cannot reach the whisper.cpp server" | `systemctl status iris-whisper` or `journalctl -u iris-whisper` |
| Robotic voice | Neither Kokoro nor Piper is running. Check `systemctl status iris-piper`, or `~/Library/Logs/iris-kokoro.log` on a Mac |
| IRIS never hears you | Find the mic with `arecord -l` and set `audio.micDevice`, e.g. `"plughw:1,0"` |
| Triggers on background noise | Raise `audio.vadThreshold` (e.g. 900) and enable `debug` to see transcripts |
| Cuts you off mid-sentence | Raise `audio.pauseMs` and/or `audio.silenceMs` |
| Wake word misheard | Add the mis-hearing to `wakeWordAliases` |
| Outfits ignore the weather | Add MagicMirror's `weather` module or set `weather.latitude`/`longitude` |
| The Mac is not used | From the Pi, `curl http://macbook.local:11434/api/version`; the Mac must be awake and set up with `--share` |

## Upgrading from older versions

From the "Jarvis" naming: the wake word is now "Iris", so remove `wakeWord: "jarvis"`, `assistantName` and `wakeWordAliases` from your config if you copied the old sample. Re-run the setup script; it moves `~/.local/share/jarvis` to `~/.local/share/iris` and renames the `jarvis-*` services to `iris-*`.

From v2 (Google Cloud): v3 replaced Google Cloud Speech, TTS and Vertex AI with local models. Run the setup script, remove `projectId`, `location`, `model`, `serviceAccountFile`, `ttsVoice` and `speechLanguage` from your config, and delete `credentials.json` and the old `node_modules/`.

## Development

```bash
npm test
```

The tests use `node:test` and need no MagicMirror install, models or hardware.

```
MMM-AI-Jarvis.js     front end: status, conversation, cards, module control
cards.js             animated data cards
director.js          whole-mirror control in the browser (move, resize, brightness, night mode)
node_helper.js       bridge between the mirror and the engine
lib/Iris.js          pipeline: mic, VAD, STT, wake word, assistant, TTS
lib/Assistant.js     conversation, fast intents and the model tool loop
lib/                 skills, sports, weather, wardrobe, outfit planner, server failover
lib/audio, stt, tts  microphone, voice activity detection, whisper.cpp client, voices
scripts/             setup-pi.sh, setup-mac.sh, kokoro_server.py
test/                node:test suite
```

## License

MIT, as declared in `package.json`.
