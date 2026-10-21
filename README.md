# IRIS for MagicMirror² (MMM-AI-Jarvis)

**IRIS: Image Recognition & Intelligent Speech.** A private, voice-controlled assistant and personal
stylist for [MagicMirror²](https://magicmirror.builders/). Say *"Iris…"* and it answers out loud in a
natural voice and puts things on the mirror:

- **real data, on animated cards:** the weather anywhere with an hourly chart, stocks and crypto
  with charts that draw themselves, the news, facts with pictures, definitions, currency, maths,
  world clocks, countdowns, and sunrise and sunset
- **live sports:** every game on right now, or your team's game updating live
- **outfits** picked from **your own wardrobe** for the weather, whether that's now, tonight or tomorrow morning
- timers and lists

It also does things before you ask:
- greets you with a **morning briefing** when you walk up
- warns you **before it rains**
- tells you when **your team's game** starts and how it ended

It runs **the whole mirror** by voice: move and resize any module, bigger text, dimming, night mode,
screen off, and saved layouts you can switch between. It can also see you through a camera and
remember your clothes and your preferences.

**Everything runs on your own hardware.** Speech recognition, the language and vision model, and the
voice are all local. There are no cloud accounts, no API keys and no usage bills, and your camera
images never leave the house.

<p align="center"><img src="docs/demo.gif" width="360" alt="IRIS answering on a MagicMirror: an animated weather card, a market chart drawing itself, news cascading in"></p>

<p align="center"><a href="#screenshots">Screenshots of every feature</a> · <a href="docs/ui-gallery.png">All states and cards</a></p>

> The module folder is still `MMM-AI-Jarvis` (the repository name), so existing installs and
> configs keep working. Only the assistant itself is now called IRIS. See
> [Coming from "Jarvis"](#coming-from-jarvis).

---

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Screenshots](#screenshots)
- [Hardware](#hardware)
- [Installation](#installation)
- [Running on a Mac (fastest, best voice)](#running-on-a-mac-fastest-best-voice)
- [Things to say](#things-to-say)
- [Building your wardrobe](#building-your-wardrobe)
- [Controlling the mirror](#controlling-the-mirror)
- [Configuration](#configuration)
- [Notifications API](#notifications-api)
- [Privacy](#privacy)
- [Troubleshooting](#troubleshooting)
- [Coming from "Jarvis"](#coming-from-jarvis)
- [Development](#development)

---

## Features

| | |
|---|---|
| 🎙️ **Hands-free voice** | Say "Iris…" and ask; follow up without repeating it; say "stop" to interrupt. Answers as soon as you finish a sentence, and never mistakes its own voice for yours |
| 🗣️ **A natural voice** | The most natural voice that's running: [Kokoro](https://huggingface.co/hexgrad/Kokoro-82M) (a Mac or PC), then Piper, then espeak-ng, picked automatically. Sentences after the first are spoken together so the intonation flows. Times, scores, dates and units are spoken the way people say them ("six forty-six", "two thirty-one left in the fourth quarter") |
| 🕰️ **Time that makes sense** | "What time is it in Tokyo?", "How long until Christmas?", "What day is Halloween?", "How many days until my birthday?" Exact answers, phrased like a person: "tonight at 7", "in 25 minutes", "tomorrow morning" |
| 👗 **Wardrobe memory** | Hold clothes up to the mirror and say "add this to my wardrobe". IRIS photographs, names and catalogues them |
| 🌦️ **Outfit planning** | "What should I wear to dinner tonight?" picks a coordinated outfit from your wardrobe for *tonight's* weather, the occasion, what you wore recently and what you like |
| 👀 **Vision** | "How do I look?" / "Does this match?" gets honest feedback from the camera |
| 🏆 **Live sports** | "What games are on right now?" shows a live scoreboard of every game across your leagues. "How are the Lakers doing?" pins one game that updates live. Covers the NFL, NBA, MLB, NHL, Premier League, Champions League, MLS and more |
| ⏱️ **Timers** | "Set a pasta timer for 10 minutes" shows a countdown and announces when it's done |
| 🪞 **The whole mirror, by voice** | "Move the calendar to the top right", "make the clock bigger", "the text is too small", "dim the mirror", "night mode", "turn the screen off", "where's the weather?", "save this layout as morning". Every change animates and is remembered across restarts. Plus "hide the news", "focus mode" and your own voice commands for any module |
| 💬 **Understands you** | Plain phrasings work ("what's Tesla going for these days?", "shove the compliments up near the top", "crank up the brightness"). On a fast model server, anything the instant patterns miss is routed to the right skill by the model |
| 📋 **Info panels** | Ask for a list, steps or a summary and IRIS puts it on screen |
| 📊 **Real data, never guessed** | Facts and pictures from Wikipedia, headlines (Google News: top stories, a topic or anything you ask about), stocks, indices, crypto and commodities (Yahoo Finance; several at once: "compare Apple and Microsoft"), exchange rates (ECB), definitions, and exact maths, tips and unit conversions. Questions about recent events ("who won the game last night?") are answered from fresh headlines. All free, with no keys |
| ✨ **Animated cards** | Weather with a moving icon and an hourly chart that draws itself; prices that count up next to self-drawing charts; news that cascades in; an analog world clock; countdowns; the sun travelling its arc |
| 🔔 **Surprises you** | A morning briefing when you walk up (weather, what to wear, your teams' games, the top story), a heads-up before it rains, and kick-off and final-score alerts for your teams. During quiet hours it shows these without speaking |
| 🧠 **Long-term memory** | "Remember that my office is business casual" is kept across restarts and used in every answer |
| 🔒 **100% local** | whisper.cpp + Ollama + Kokoro/Piper. No cloud, no keys |

## How it works

```
 microphone ─► voice activity detection ─► whisper.cpp ─► wake word ─┐
               (speech only; transcribing  (speech-to-text)          │  its own voice is filtered out
                starts at the first pause)                           ▼
                                       ┌──────────── fast intents: time, weather, scores, stocks, timers,
                                       │             outfits, the whole display, memory (no LLM needed)
                                       ▼
                                 router (fast servers) ── picks a skill for free-form requests
                                       ▼
                                 Ollama (qwen3.5) ◄── grounding: Wikipedia facts, fresh headlines
                                 language + vision    tools: camera, wardrobe, weather, scores, …
                                       │
              mirror UI ◄── live cards ┤   written form: "7:30 PM", "58°"
              speaker   ◄── Kokoro / Piper ◄── spoken form: "seven thirty p.m.", "58 degrees"
```

- **Voice activity detection** cuts the microphone stream into sentences locally, so the speech
  recogniser only runs when someone is talking. It adapts to room noise and ignores fans and hums.
- **Early end-pointing.** At the first short pause (300 ms), IRIS starts transcribing. If the
  transcript is clearly complete ("Iris." on its own, or a finished question), it answers without
  waiting out the full end-of-sentence silence. If you keep talking, the guess is dropped.
- **Echo suppression.** Anything heard while IRIS is speaking needs the wake word ("Iris, stop"),
  and transcripts that repeat what it just said are dropped. So it never answers its own reply,
  even through a laptop's speakers.
- **Fast intents** handle the most common requests directly or with a single structured model call:
  time, weather, scores, timers, outfits, camera, screen control, memory and "put … on the mirror".
  Small local models sometimes guess wrong, or claim they did something they didn't, so the
  important paths don't depend on them. Everything else goes to the LLM, which can call the same tools.
- **The router** asks the model to pick one skill from a fixed list and fill in its subject, as JSON
  ("what's Tesla going for?" → stock, Tesla). Small models fill a schema far more reliably than they
  call tools freely. Ollama can't cache any of its prompt on qwen3.5 (measured), so each routing call
  costs about a second on a Mac and 15–20 s on a Pi. By default (`llm.router: "auto"`) it only runs
  when IRIS measures the model's server as fast enough, and only for requests that look like they
  want a skill ("the calendar would look better on the left"). Conversation and questions go
  straight to the model with no added delay. On a Pi, the instant patterns cover the common
  paraphrases instead.
- **Grounding.** Factual questions get a Wikipedia extract in front of the model, and questions
  about things that change ("who won…", "who's the CEO of…", "latest…") get today's headlines, so
  a small model answers from facts instead of guessing.
- **Live cards** (scoreboards, timers, outfits, info panels) are managed on the server and refresh on
  their own. Live games update every 20–30 seconds, and a score animates when someone scores.

### Why it sounds like a person

Small text-to-speech voices read text literally:

| Written | Old reading | Now |
|---|---|---|
| "7:00 PM" | "seven zero zero P D M" | "seven p.m." |
| "6:46" | "six hundred forty-six" | "six forty-six" |
| "67'" | (nothing) | "67th minute" |

IRIS fixes this in two layers:

1. **Replies are written the way a person talks.**
   - Weather: "It's 15° and sunny right now, but it feels more like 11°. Down to 7° tonight." Not a
     list of numbers.
   - Sports: "The Knicks lead the 76ers 98-91 with 2:31 left in the 4th quarter."
   - Times: "Tonight at 7", "tomorrow at 1 PM", "in 25 minutes", "an hour and a half".
   - Common phrasings vary a little, so it doesn't repeat the same sentence every time.
2. **A speech normalizer** rewrites each sentence just before it's spoken. It handles times, game
   clocks, soccer minutes, dates, °, %, mph, km/h, "vs" and ranges. The mirror still shows the
   tidy written form.

   Every rule was checked by speaking with the voice and transcribing the result back with Whisper.

On a Mac, the voice is **Kokoro-82M**, which sounds far closer to a person than Piper. Piper stays as
the instant fallback, so a sleeping Mac never leaves the mirror mute. If only the robotic espeak-ng
voice is available, the mirror says so and how to fix it, and IRIS switches back on its own when a
natural voice comes up.

The first sentence of a reply is synthesised on its own so IRIS starts talking right away. The
sentences waiting after it are spoken together, so the voice carries its intonation across them
instead of reading a string of separate lines. IRIS measures how fast the voice synthesises and only
merges what will be ready before the current sentence finishes, so merging never causes a pause:
Kokoro on a Mac merges generously, a slower voice merges little.

### Any screen

The layout adapts to the display: a portrait mirror, a MacBook's landscape screen or a TV. On a
landscape screen cards sit side by side. IRIS measures the space the other modules leave and fits
into it: when there isn't room for every card, older ones are set aside (the newest always shows,
and the rest return when there's space), and next to a clock or weather column it narrows to the gap
between them. It re-fits when the window resizes or another module changes size.

### Built for speed on a Raspberry Pi

A Pi has no GPU, so every token the language model reads or writes costs time. IRIS is designed
around that, and each choice below was measured:

- **Most requests never touch the language model.** Time, weather, scores, timers, screen control,
  preferences and **outfit picks** are handled by fast intents and a rule-based outfit planner,
  which answer in milliseconds.
- **Small prompts.** Each request carries only the tools its words point to ("set a timer" sends one
  tool, "tell me a joke" none), cutting a plain question's prompt from ~2,500 to ~100–200 tokens.
- **Streaming speech.** IRIS starts talking as soon as the first sentence is written, and the next
  sentence is synthesised while the current one plays.
- **Instant acknowledgement.** Slower requests (panels, the camera) say "On it…" straight away.
- **Fast defaults.**

  | Default | Measured |
  |---|---|
  | `qwen3.5:2b` | About 35% faster than 4b |
  | Whisper `tiny.en` | 2.3× faster than `base.en`, same accuracy in testing |
  | Piper voice kept loaded as a service | 10–25× faster than starting it per sentence |
  | Model kept in memory (`keepAlive: -1`) | No reload from the SD card |

## Screenshots

Captured from the real module running in MagicMirror 2.38, each after a real request (except where
noted). Full size in [`docs/features`](docs/features).

| | | |
|---|---|---|
| ![Idle](docs/features/01-idle.png)<br>**Idle** | ![Outfit](docs/features/02-outfit.png)<br>**"What should I wear to dinner tonight?"** | ![Weather](docs/features/03-weather.png)<br>**"What's the weather like tonight?"** |
| ![Games on now](docs/features/14-games-on-now.png)<br>**"What games are on right now?"** (live) | ![Next game](docs/features/04-next-game.png)<br>**"When do the Lakers play?"** | ![Live score](docs/features/05-live-score-demo.png)<br>**One live game** (demo data) |
| ![Time zones](docs/features/12-time-zones.png)<br>**"What time is it in Tokyo?"** | ![Countdown](docs/features/13-countdown.png)<br>**"How long until Christmas?"** | ![Timer](docs/features/06-timer.png)<br>**"Set a pasta timer for 10 minutes"** |
| ![Panel](docs/features/07-info-panel.png)<br>**"Put a packing list for the beach on the mirror"** | ![Focus](docs/features/08-focus-mode.png)<br>**"Focus mode"** | ![Scanning](docs/features/09-camera-scanning.png)<br>**"Add these clothes to my wardrobe"** |
| ![Added](docs/features/10-wardrobe-added.png)<br>**…added, with photo crops** | ![Warning](docs/features/11-setup-warning-example.png)<br>**Setup problem shown on the mirror** (example) | ![Briefing](docs/features/15-briefing.png)<br>**"Good morning"** (also automatic) |
| ![Paris](docs/features/16-weather-paris.png)<br>**"What's the weather in Paris?"** | ![Markets](docs/features/17-markets.png)<br>**"How's the stock market doing?"** | ![Stock](docs/features/18-stock.png)<br>**"How is Nvidia stock doing?"** |
| ![News](docs/features/19-news.png)<br>**"What's the news?"** | ![Knowledge](docs/features/20-knowledge.png)<br>**"Who is Taylor Swift?"** | ![Sunset](docs/features/21-sunset.png)<br>**"When is sunset?"** |
| ![Currency](docs/features/22-currency.png)<br>**"Convert 100 dollars to euros"** | ![Maths](docs/features/23-math.png)<br>**"What's 17% of 240?"** | ![Definition](docs/features/24-definition.png)<br>**"Define serendipity"** |
| ![Grounded](docs/features/25-grounded-fact.png)<br>**"How tall is Mount Everest?"** (model + Wikipedia) | ![Move and resize](docs/features/26-move-resize.png)<br>**"Move the clock to the top right"**, then **"make it bigger"** | ![Night mode](docs/features/27-night-mode.png)<br>**"Night mode"** |
| ![Stock](docs/features/29-stock-paraphrase.png)<br>**"What's Tesla going for these days?"** | ![Voice warning](docs/features/28-voice-warning.png)<br>**Robotic fallback voice, explained on the mirror** | |

## Hardware

| Setup | Model | Voice | Notes |
|---|---|---|---|
| **Apple Silicon Mac** (M1 or newer) driving the mirror | `qwen3.5:4b` | Kokoro | Fastest, and the most natural voice: the model runs on the Mac's GPU. A Mac with a broken built-in screen is ideal. See [Running on a Mac](#running-on-a-mac-fastest-best-voice) |
| **Raspberry Pi + a Mac on your network** | `qwen3.5:4b` on the Mac | Kokoro on the Mac, Piper on the Pi | The Pi drives the mirror; the Mac does the thinking and talking, with the Pi as automatic fallback |
| Raspberry Pi 5, 8 GB | `qwen3.5:2b` | Piper | Everything on the Pi. Use active cooling: the LLM keeps all cores busy while it thinks |
| Raspberry Pi 5, 4 GB | `qwen3.5:2b` | Piper | Fits comfortably (~2.7 GB for the model) |
| Raspberry Pi 4, 8 GB | `qwen3.5:2b` | Piper | Usable, but noticeably slower for open questions |

`qwen3.5:4b` gives somewhat better answers but generated about 35% slower in testing. `qwen3.5:2b`
is also the smallest recommended: `qwen3.5:0.8b` sometimes claimed to have done things (like saving
a preference) without actually calling the tool. Kokoro needs about 0.5 s of computing per second
of speech on a 4-core x86 CPU. That is several times faster on Apple Silicon, but too slow for a Pi
to keep up, so the Pi keeps Piper.

**What to expect.** The table below was measured inside MagicMirror 2.38 on a 4-core x86 test VM
with **no GPU**, running `qwen3.5:2b`. Time is from the request to the answer being ready to speak.

| Request | How it's answered | Answer ready |
|---|---|---|
| "What time is it in Tokyo?" / "How long until Christmas?" | clock & calendar | **< 10 ms** |
| "What should I wear to dinner tonight?" | rule-based planner | **< 10 ms** |
| "What's the weather like tonight?" | hourly forecast (Open-Meteo) | **0.6 s** (network) |
| "What games are on right now?" | 10 ESPN scoreboards in parallel | **1.0 s** |
| "When do the Lakers play?" | ESPN feed | **0.9 s** |
| "Set a pasta timer for 10 minutes" / "focus mode" | fast intent | **< 10 ms** |
| Open questions ("what's the capital of Australia?") | language model, streamed | first words in **~3.5–6 s** |
| "Put a packing list for the beach on the mirror" | language model | "On it" at once, panel in ~12 s |
| "Add these clothes to my wardrobe" | vision model | acknowledgement at once, ~50–100 s |

These are **not Raspberry Pi or Mac measurements**. A Pi 5 will be slower for anything that uses the
language model; an Apple Silicon Mac will be much faster.

**Wake word and speech recognition.** Real speech was streamed in real time through the voice
detector and Whisper on the same VM. The time is from the end of speech to IRIS reacting:

| Whisper model | Without early end-pointing | With it (default) |
|---|---|---|
| `tiny.en` | 1.16 s | **0.68 s** |
| `base.en` | 1.71 s | **1.31 s** |

The rows that don't need the language model stay instant on any hardware. To make the others fast,
run the model on an Apple Silicon Mac ([below](#running-on-a-mac-fastest-best-voice)). It's the
single biggest speed-up.

You'll also need:

- **64-bit OS**: Raspberry Pi OS (Bookworm or newer) or Debian/Ubuntu
- **MagicMirror² 2.20 or newer** (tested against **v2.38.0**, which requires Node.js ≥ 22.22.2)
- **A USB microphone**; a conference-style mic works best from across a room
- **A speaker** (USB, 3.5 mm or HDMI audio)
- **A camera** (optional, for vision and wardrobe): the Raspberry Pi Camera Module or any USB webcam

## Installation

### 1. Get the module

```bash
cd ~/MagicMirror/modules
git clone https://github.com/RedNetty/MMM-AI-Jarvis.git
```

There are **no npm dependencies**, so there's no `npm install` step.

### 2. Install the local AI stack

The setup script installs and configures everything: Ollama with a model sized to your RAM,
whisper.cpp and Piper as background services, and the audio and camera tools.

```bash
cd ~/MagicMirror/modules/MMM-AI-Jarvis
scripts/setup-pi.sh
```

It takes a while on first run (it compiles whisper.cpp and downloads a few GB of models). At the end
it plays a test phrase and prints the config block to paste. Options:

```bash
scripts/setup-pi.sh --model qwen3.5:4b          # smarter, slower model
scripts/setup-pi.sh --voice en_GB-alan-medium   # a different Piper voice (listen at https://rhasspy.github.io/piper-samples/)
scripts/setup-pi.sh --whisper-model base.en     # more robust speech recognition in noisy rooms (slower)
scripts/setup-pi.sh --whisper-model tiny        # languages other than English (tiny.en is English-only)
scripts/setup-pi.sh --brain macbook.local       # use a Mac on your network first (see below)
scripts/setup-pi.sh --no-ollama                 # if the model runs on another computer
```

<details>
<summary><b>Manual installation (what the script does)</b></summary>

```bash
# System tools
sudo apt install alsa-utils espeak-ng fswebcam curl zstd git cmake build-essential python3-venv

# Ollama + model
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3.5:2b

# whisper.cpp server on port 8178 (MagicMirror already uses 8080)
git clone --depth 1 https://github.com/ggml-org/whisper.cpp.git ~/.local/share/iris/whisper.cpp
cd ~/.local/share/iris/whisper.cpp
cmake -B build -DCMAKE_BUILD_TYPE=Release && cmake --build build -j --target whisper-server
bash models/download-ggml-model.sh tiny.en
./build/bin/whisper-server -m models/ggml-tiny.en.bin --host 127.0.0.1 --port 8178

# Piper voice server on port 5005
python3 -m venv ~/.local/share/iris/piper-venv
~/.local/share/iris/piper-venv/bin/pip install "piper-tts[http]"
mkdir -p ~/.local/share/iris/voices && cd ~/.local/share/iris/voices
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx
curl -LO https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json
~/.local/share/iris/piper-venv/bin/python -m piper.http_server -m en_US-lessac-medium.onnx --host 127.0.0.1 --port 5005
```

The script also installs `iris-whisper` and `iris-piper` systemd services so both servers start
at boot, and limits Ollama to one loaded model to keep RAM use predictable.
</details>

### 3. Add it to your config

In `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-AI-Jarvis",
  position: "lower_third",
  config: {
    userName: "Alex",
    llm: { model: "qwen3.5:2b" },
    weather: { latitude: 40.71, longitude: -74.01 }, // optional: hourly forecasts for "tonight", "tomorrow morning"
  },
},
```

That's all most people need; the defaults match the setup script. Restart MagicMirror and say
**"Iris, what should I wear today?"**

If something isn't running, IRIS shows the problem in amber on the mirror (for example
*"Cannot reach Ollama…"*) and keeps re-checking, so services that start after MagicMirror at boot
are picked up automatically.

## Running on a Mac (fastest, best voice)

An Apple Silicon Mac (M1 or newer) runs the language model and speech recognition on its GPU. That
makes the model-based features dramatically faster than on a Pi's CPU, and it's fast enough for the
natural **Kokoro** voice. A MacBook with a **broken built-in screen** works perfectly: it never needs
its own display.

There are two ways to use it.

**A. The Mac is the mirror computer (no Pi).** Connect the mirror's display to the Mac (USB-C to
HDMI) and plug a USB microphone, speaker and (optionally) webcam into the Mac.

```bash
git clone https://github.com/MagicMirrorOrg/MagicMirror ~/MagicMirror
cd ~/MagicMirror && npm run install-mm
git clone https://github.com/RedNetty/MMM-AI-Jarvis.git modules/MMM-AI-Jarvis
modules/MMM-AI-Jarvis/scripts/setup-mac.sh
```

Add the config block it prints to `~/MagicMirror/config/config.js`. Then start the mirror from
`~/MagicMirror` with `./node_modules/.bin/electron js/electron.js`. Don't use MagicMirror's own
`npm run start`: it adds Linux-only display flags.

On macOS, IRIS uses `ffmpeg` for the microphone and camera and the built-in `afplay` for sound; the
setup script installs ffmpeg. The first time, macOS asks for **microphone and camera permission**;
allow it.

**B. The Mac is the brain for a Raspberry Pi mirror.** The Pi keeps driving the display, mic,
speaker and camera, and sends the heavy work (and the voice) to the Mac over your home network.

```bash
# On the Mac
scripts/setup-mac.sh --share

# On the Pi (macbook.local = the name setup-mac.sh prints)
scripts/setup-pi.sh --brain macbook.local
```

The Pi's config then lists the Mac first and the Pi itself as a fallback:

```js
stt: { whisperUrl: ["http://macbook.local:8178", "http://127.0.0.1:8178"] },
tts: { kokoroUrl: "http://macbook.local:5006", piperUrl: "http://127.0.0.1:5005" }, // Kokoro, else Piper, else espeak
llm: {
  servers: [
    { url: "http://macbook.local:11434", model: "qwen3.5:4b" },
    { url: "http://127.0.0.1:11434", model: "qwen3.5:2b" },
  ],
},
```

With the model on the Mac, IRIS also turns on its router (see [How it works](#how-it-works)), so
free-form requests reach the right skill. IRIS checks each server in the background every 15 seconds. If the Mac is asleep or off, requests
go straight to the Pi with no waiting for timeouts, and the Pi's Piper voice speaks. When the Mac
comes back, IRIS loads the model there in the background and switches back to it and to Kokoro.
Failover was tested in MagicMirror by stopping and starting servers mid-session.

**What the setup script does on the Mac:**
- Installs Ollama, ffmpeg, espeak-ng, cmake and Python with Homebrew. Builds whisper.cpp with
  Metal, and installs Kokoro (`kokoro-onnx`, int8 model) and Piper.
- Runs Ollama, whisper, Kokoro and Piper as **LaunchAgents**: they start when you log in and restart
  if they stop. Logs are in `~/Library/Logs/iris-*.log`. Turn on automatic login (System Settings →
  Users & Groups) so a reboot needs no screen.
- Keeps the Mac awake on power, including with the lid closed (`pmset`). Use `--keep-sleep` to skip.
  To undo: `sudo pmset -a disablesleep 0`.
- With `--share`: listens on your network and allows the services through the macOS firewall.
  These services have no password, so only use `--share` on a home network you trust.
- Options:
  - `--kokoro-voice` picks a different voice. Choices include `af_heart` (default), `af_bella`,
    `am_michael`, `am_adam`, `bf_emma` and `bm_george`.
  - `--no-kokoro` keeps Piper as the voice.

Tips for a screenless Mac:
- Control it from another computer with **Screen Sharing**: enable System Settings → General →
  Sharing → Screen Sharing, then connect to `vnc://macbook.local`.
- Or use SSH: enable Sharing → Remote Login.
- With the lid closed, a MacBook's own microphone and camera switch off, so use USB ones.

Any other computer with a GPU can be the brain too: install Ollama, set `OLLAMA_HOST=0.0.0.0`, and
list it in `llm.servers`. `scripts/kokoro_server.py` runs on Linux and Windows as well, for the voice.

## Things to say

Start with "Iris", then ask. After an answer, you have a few seconds to follow up **without**
the wake word ("…and something warmer?"). Say **"stop"** to interrupt. "Hey Iris" and "OK Iris" work too.

**Time & dates**
- "What time is it?" · "What's the date?" · "What time is it in London?"
- "How long until Christmas?" · "How many days until Friday?" · "How long until 6 PM?"
- "What day is Halloween?" · "What's the date next Tuesday?" · "How many days until my birthday?"
  (after "remember that my birthday is March 3rd")

**Style & wardrobe**
- "Iris, what should I wear today?" · "…to dinner tonight?" · "…for a job interview tomorrow?" · "something warmer"
- "How do I look?" · "Does this go together?" · "What am I wearing?"
- "Add this jacket to my wardrobe" (hold it up to the mirror)
- "Add my black leather boots to my wardrobe" (by voice, no photo)
- "Show me my blue tops" · "Remove the grey hoodie from my wardrobe"
- "I'm wearing that" (logs the suggested outfit so it isn't repeated tomorrow)

**Weather**
- "What's the weather like?" · "…tonight?" · "…tomorrow morning?"
- "Do I need an umbrella?" · "Do I need a jacket?" · "Can I wear shorts tomorrow?" · "Is it windy?"

**On the screen**
- "What games are on right now?" · "Any soccer on?" · "What are the NBA scores?" · "Who's playing tonight?"
- "What's the score of the Lakers game?" · "Did the Yankees win?" · "When do Arsenal play?"
- "Set a pasta timer for 12 minutes" · "How much time is left?" · "Cancel the timer"
- "Put a packing list for the beach on the mirror"
- "Hide the news" · "Show the calendar" · "Focus mode" · "Bring back everything" · "Close that"

**The mirror itself**
- "Move the calendar to the top right" · "Put the weather on the left" · "Move yourself to the bottom"
- "Make the clock bigger" · "Shrink the news" · "The text is too small" · "I can't read the calendar"
- "Dim the mirror" · "It's too bright" · "Brightness 40 percent" · "Turn the screen off" · "Wake up"
- "Night mode" · "Day mode" · "Where's the calendar?" (it pulses) · "What's on the screen?"
- "Save this layout as morning" · "Switch to my morning layout" · "Reset the layout" · "Reload the mirror"

**Knowledge & data**
- "Good morning" · "Brief me" · "What does my day look like?"
- "Who is Taylor Swift?" · "Tell me about the Eiffel Tower" · "What is a black hole?"
- "How tall is Mount Everest?" (answered by the model, with Wikipedia's facts in front of it)
- "What's the news?" · "Tech headlines" · "What's the latest on SpaceX?"
- "How's the stock market doing?" · "How is Apple stock?" · "Price of bitcoin this week"
- "What's Tesla going for?" · "Compare Apple and Microsoft" · "Is Nvidia up today?" · "Amazon's 52-week high"
- "Who won the game last night?" · "Who's the CEO of OpenAI?" (answered from today's headlines)
- "Convert 100 dollars to euros" · "What's the euro exchange rate?"
- "Define serendipity" · "What does ephemeral mean?"
- "What's 17% of 240?" · "A 20% tip on $85" · "How many cups in a liter?" · "180 cm in feet"
- "When is sunset?" · "What time does the sun come up tomorrow?"

**Memory & everything else**
- "Remember that my office is business casual" · "Forget that I hate yellow"
- "Tell me a joke" · anything you'd ask an assistant

## Building your wardrobe

1. Stand in front of the mirror in good light.
2. Hold one or a few items up to the camera and say **"Iris, add these to my wardrobe."**
3. IRIS photographs them and identifies each piece. It records the name, category, colours,
   material, formality, warmth and season, and shows each one on screen, cropped from the photo.

Tips:
- One to three items per photo works best, held flat against a plain background.
- You can correct anything by voice: "Change the grey hoodie to warmth 4".
- Shoes and accessories count too. Outfits are better when IRIS knows your shoes.
- Say "I'm wearing that" after a suggestion. IRIS avoids repeating recently worn pieces.

Your wardrobe lives in `data/wardrobe.json` (plus photos in `data/photos/`). It's plain JSON you can
back up or edit.

## Controlling the mirror

<p align="center"><img src="docs/director.gif" width="300" alt="IRIS moving the clock and compliments, enlarging the clock, pointing out the weather, night mode, screen off and on, and resetting the layout"></p>

IRIS knows which modules are on your mirror, so you can refer to them naturally ("the news",
"the calendar", "the weather", "top left", "yourself"). It can:

- **Move** any module to another region: "move the calendar to the top right". The module glides
  to its new place.
- **Resize** one module ("make the clock bigger", "shrink the news") or **all text** ("the text is
  too small"; MagicMirror sizes everything from one font size).
- **Dim** the mirror, set a brightness, or **turn the screen off**. Saying "Iris" (or someone
  walking up, with a presence sensor) turns it back on.
- **Night mode** dims and warms everything, for a bedroom mirror.
- **Point things out:** "where's the calendar?" pulses a ring around it.
- **Remember layouts:** "save this layout as morning", then "switch to my morning layout" any
  time. "Reset the layout" puts everything back as configured.

The current layout is kept in `data/layout.json` and re-applied when MagicMirror starts. Moves and
sizes are applied in the browser, so your `config.js` is never touched.

Hiding and showing go through MagicMirror's own lock mechanism, so IRIS never fights
page-switching modules like MMM-pages. A module hidden by something else stays hidden.

**Auto-hide:** modules listed in `display.autoHide` (by default `compliments`, which shares the lower
third) fade out while IRIS is talking or showing a card, and come back afterwards. Once you move one
somewhere else, it no longer shares the space and stays visible.

**Your own voice commands:** map any phrase to a MagicMirror notification to drive other modules:

```js
customCommands: [
  { phrases: ["next page"], notification: "PAGE_INCREMENT", reply: "Next page." },      // MMM-pages
  { phrases: ["previous page"], notification: "PAGE_DECREMENT", reply: "Going back." },
  { phrases: ["screen off"], notification: "REMOTE_ACTION", payload: { action: "MONITOROFF" } }, // MMM-Remote-Control
],
```

## Configuration

Every option is optional. Nested sections merge with the defaults, so `llm: { model: "qwen3.5:2b" }`
keeps every other `llm` setting. See [`config/config.js.sample`](config/config.js.sample) for a
fully commented copy.

<details open>
<summary><b>General</b></summary>

| Option | Default | Description |
|---|---|---|
| `assistantName` | `"Iris"` | Name used on screen and in replies |
| `wakeWord` | `"iris"` | Word that starts a request |
| `wakeWordAliases` | `["aris","irus","iras","eyeris"]` | Mis-hearings that also count |
| `userName` | `""` | Personalises replies |
| `language` | `"en"` | Speech recognition language (`de`, `fr`, `es`…; needs a multilingual Whisper model) |
| `locale` / `units` | MagicMirror's | Date and time format (12/24-hour), and metric/imperial |
| `dataDir` | `"data"` | Where wardrobe, memory and photos are stored |
| `customCommands` | `[]` | Phrase → notification mappings (see above) |
| `debug` | `false` | Log transcripts and timings |
</details>

<details>
<summary><b>stt</b> – speech recognition</summary>

| Option | Default | Description |
|---|---|---|
| `whisperUrl` | `"http://127.0.0.1:8178"` | whisper.cpp server, or a list for failover (e.g. a Mac, then the Pi) |
</details>

<details>
<summary><b>tts</b> – voice</summary>

| Option | Default | Description |
|---|---|---|
| `provider` | `"auto"` | `"auto"`: the most natural voice that's running (Kokoro, then Piper, then espeak-ng) · `"kokoro"` (falls back to Piper) · `"piper"` · `"espeak"` (robotic, needs no setup) |
| `kokoroUrl` | `""` | Kokoro voice server (`scripts/kokoro_server.py`, installed by `setup-mac.sh`), or a list. Empty = this machine (`http://127.0.0.1:5006`) |
| `kokoroVoice` / `kokoroSpeed` | `"af_heart"` / `null` | Kokoro voice and speed (`1.1` is a little faster) |
| `piperUrl` | `"http://127.0.0.1:5005"` | Piper voice server (keeps the voice loaded, ~0.2 s per sentence), or a list for failover |
| `piperCommand` / `piperModel` | setup-script paths | Piper CLI fallback, used automatically if the server is down |
| `piperSpeaker` | `null` | Speaker id for multi-speaker voices |
| `piperLengthScale` | `null` | Speaking speed (`0.9` faster, `1.1` slower) |
| `espeakVoice` / `espeakSpeed` | `"en-us"` / `165` | espeak-ng settings |
| `mergeChars` | `260` | After the first sentence, speak waiting sentences together for natural flow: at most this many characters, and only as much as the voice can prepare before the current sentence ends. `0` = one sentence at a time |

With `provider: "auto"`, each sentence goes to Kokoro while it's reachable, then Piper, then espeak-ng.
Servers are probed in the background, so a sleeping Mac costs no waiting. While only espeak-ng
works, the mirror says so; the note disappears when a natural voice comes back.
</details>

<details>
<summary><b>llm</b> – language & vision model</summary>

| Option | Default | Description |
|---|---|---|
| `servers` | `[]` | Several Ollama servers in order of preference, each `{ url, model }` (e.g. a Mac, then the Pi). Empty = `ollamaUrl` + `model` |
| `ollamaUrl` | `"http://127.0.0.1:11434"` | Ollama server (can be another computer) |
| `model` | `"qwen3.5:2b"` | Any Ollama model. Use one with *tools* and *vision* for all features |
| `visionModel` | `""` | Separate model for camera images (empty = `model`) |
| `keepAlive` | `-1` | How long the model stays loaded (`-1` = forever; reloading from an SD card is slow) |
| `temperature` / `maxTokens` / `contextSize` | `0.4` / `160` / `4096` | Generation settings (short spoken replies are faster) |
| `think` | `false` | Let "thinking" models reason first (smarter, slower) |
| `fastIntents` | `true` | Handle common requests without the LLM |
| `router` | `"auto"` | Let the model pick the right skill for free-form requests. `"auto"` = only for requests that look like they want a skill, and only while the model's server is fast enough that it adds under ~2 s (a Mac yes, a Pi no) · `true` = every request · `false` = never |
| `outfitPlanner` | `"fast"` | `"fast"`: instant rule-based picks · `"ai"`: the language model chooses (richer reasons, much slower on a Pi) |
</details>

<details>
<summary><b>audio</b> – microphone & speaker</summary>

| Option | Default | Description |
|---|---|---|
| `micDevice` | `"default"` | Pi: ALSA device (`arecord -L`), e.g. `"plughw:1,0"`. Mac: `"default"`, an index or a name (`ffmpeg -f avfoundation -list_devices true -i ""`). `"none"` disables the mic |
| `speakerDevice` | `"default"` | Pi: ALSA playback device (`aplay -L`). Mac: uses the system output (System Settings → Sound) |
| `vadThreshold` | `500` | Minimum loudness counted as speech; raise it if noise triggers IRIS |
| `noiseMultiplier` | `3` | Speech must be this many times louder than the room |
| `silenceMs` | `750` | Pause that ends a sentence (lower is snappier but may cut off slow talkers) |
| `pauseMs` | `300` | Start transcribing at a pause this short; a complete request is answered without waiting out `silenceMs` (`0` = off) |
| `preRollMs` / `minUtteranceMs` / `maxUtteranceMs` | `400` / `350` / `15000` | Utterance shaping |
| `allowBargeIn` | `true` | Listen while speaking so "Iris, stop" works. Its own voice is filtered out either way |
| `chime` / `chimeVolume` | `true` / `0.25` | Tone when you say just the wake word |
</details>

<details>
<summary><b>camera</b></summary>

| Option | Default | Description |
|---|---|---|
| `enabled` | `true` | Turn vision features on/off |
| `tool` | `"auto"` | `rpicam-still`, `libcamera-still`, `fswebcam`, `ffmpeg`, `custom`, or `auto` (on a Mac: ffmpeg) |
| `device` | `"/dev/video0"` | Pi: USB webcam device. Mac: `"default"`, an index or a camera name |
| `width` / `height` | `960` / `720` | Photo size. Bigger photos make vision noticeably slower (1280×960 took ~1.8× as long in testing) |
| `rotation` / `flip` | `0` / `false` | `180` for an upside-down camera; `flip` mirrors horizontally |
| `warmupMs` | `1200` | Time for auto-exposure to settle |
| `customCommand` | `[]` | For `tool: "custom"`: a command that writes a JPEG to stdout (`{width}`, `{height}`, `{device}` are filled in) |
</details>

<details>
<summary><b>weather</b>, <b>sports</b>, <b>search</b></summary>

| Option | Default | Description |
|---|---|---|
| `weather.latitude` / `longitude` | `null` | Set to fetch from Open-Meteo (free, no key), with hourly data for "tonight" and "tomorrow morning". Leave `null` to reuse MagicMirror's weather module |
| `weather.locationName` | `""` | Shown in answers when using coordinates |
| `sports.enabled` | `true` | Live scores from ESPN's public feed (no key) |
| `sports.leagues` | NFL, NBA, MLB, NHL, EPL, MLS, UCL, LaLiga, Bundesliga, Serie A | Searched for "what games are on" and when you don't name a league. Also available: `ncaaf`, `wnba`, `ncaab`, `championship`, `ligue1`, `uel` |
| `sports.favorites` | `[]` | Your teams, e.g. `["Lakers", "Arsenal"]`: in the briefing, plus kick-off and final-score alerts |
| `info.enabled` | `true` | Wikipedia, news, markets, exchange rates and definitions (free, no keys). `false` keeps IRIS fully offline apart from weather and scores |
| `info.newsFeeds` | `[]` | RSS feeds to use for "the news" instead of Google News top stories |
| `info.currency` | from `locale` | Home currency for conversions |
| `search.searxngUrl` | `""` | Optional self-hosted [SearXNG](https://docs.searxng.org) for web answers (enable the `json` format in its settings) |

Outfit suggestions and weather answers need weather data. Easiest is MagicMirror's built-in
`weather` module (any provider; `openmeteo` needs no key), which IRIS listens to automatically. Its
hourly forecast (`type: "hourly"`) is used for "tonight" questions too.
</details>

<details>
<summary><b>proactive</b> – things IRIS does on its own</summary>

| Option | Default | Description |
|---|---|---|
| `proactive.enabled` | `true` | Turn all of these on or off |
| `proactive.briefing` / `briefingHours` | `true` / `[5, 11]` | A morning briefing the first time someone is around. Presence comes from someone talking near the mirror, or from a sensor module that sends `USER_PRESENCE` (MMM-PIR-Sensor, face recognition). Once a day, and never on top of a question |
| `proactive.rainAlerts` | `true` | "Heads up: rain is likely in about 40 minutes." Needs hourly data (`weather.latitude/longitude`, or the weather module with `type: "hourly"`) |
| `proactive.teamAlerts` | `true` | Kick-off and final score for `sports.favorites`, with the live scoreboard pinned |
| `proactive.quietHours` | `[22, 7]` | Alerts are shown but not spoken |
| `proactive.awayAfterMinutes` | `15` | If nobody has been heard or seen for this long, alerts are shown but not spoken |
</details>

<details>
<summary><b>conversation</b> & <b>display</b></summary>

| Option | Default | Description |
|---|---|---|
| `conversation.listenTimeout` | `8000` | After the bare wake word, how long to wait for the question |
| `conversation.followUpWindow` | `8000` | Reply without the wake word for this long after an answer (`0` = off) |
| `conversation.historyTurns` | `6` | Exchanges remembered within a conversation |
| `conversation.resetAfter` | `300000` | Start fresh after this long idle |
| `display.showTranscription` / `showResponse` | `true` | Show what you said / what IRIS said |
| `display.clearAfter` | `30000` | Fade the conversation after this long idle |
| `display.maxWidgets` | `4` | Cards on screen at once (running timers are never dropped) |
| `display.cardTimeout` / `infoTimeout` / `snapshotTimeout` | `90000` / `180000` / `8000` | Card lifetimes |
| `display.autoHide` | `["compliments"]` | Modules faded out while IRIS is active |
| `display.showProblems` | `true` | Show setup problems on the mirror |
</details>

## Notifications API

Other modules (or MMM-Remote-Control) can drive IRIS:

| Send | Payload | Effect |
|---|---|---|
| `IRIS_ASK` | `"text"` or `{ text }` | Ask a question as if spoken (no wake word needed) |
| `IRIS_STOP` | – | Stop talking / cancel |

The old `JARVIS_ASK` and `JARVIS_STOP` are still accepted.

IRIS broadcasts:

| Notification | Payload |
|---|---|
| `IRIS_STATE` | `{ state }`: `idle`, `listening`, `processing`, `speaking` |
| `IRIS_RESPONSE` | `{ text }`: every answer |
| `IRIS_TIMER_DONE` | `{ label }` |

IRIS also listens for `USER_PRESENCE` (`true` / `false`, as sent by MMM-PIR-Sensor and similar
modules) to know when someone is at the mirror.

Example: to show a daily outfit at 7:30, use
[MMM-ModuleScheduler](https://github.com/ianperrin/MMM-ModuleScheduler)'s `notification_schedule`
to send `IRIS_ASK` with `"What should I wear today?"`.

## Privacy

- **Audio** is processed in memory. Nothing is recorded to disk, and only speech after the voice
  detector triggers is transcribed, all locally.
- **The camera** is only used when you ask something that needs it. Snapshots for "how do I look"
  are kept in memory and shown briefly; only photos of clothing you add to your wardrobe are saved
  (`data/photos/`).
- **No cloud AI services** are used for any of this. The only outbound requests fetch public data,
  never your audio or images, and all are optional:
  - sports scores (ESPN)
  - weather (Open-Meteo: only if you set coordinates, or ask about another city)
  - Wikipedia, Google News RSS, Yahoo Finance, Frankfurter (ECB rates), and the Free Dictionary
    API or Wiktionary (`info.enabled: false` turns these off)
  - web search (your own SearXNG)
  
  Only the topic is sent; your question's wording stays local.
- Delete `data/` to wipe everything IRIS knows.

## Troubleshooting

| Problem | Fix |
|---|---|
| Amber "Cannot reach Ollama" | `systemctl status ollama`; check `llm.ollamaUrl` |
| "Ollama model … is not installed" | `ollama pull <model>` |
| "Cannot reach the whisper.cpp server" | `systemctl status iris-whisper` / `journalctl -u iris-whisper` |
| Robotic voice (the mirror says "robotic backup voice") | Neither Kokoro nor Piper is running. Pi: `systemctl status iris-piper`. Mac: see `~/Library/Logs/iris-kokoro.log`. Or re-run the setup script |
| The voice changed | Piper speaks while the Kokoro server (the Mac) is unreachable, and Kokoro takes over again when it's back |
| Unusual phrasings aren't understood on a Pi | The router is off there because it would add 15–20 s per request (the log says "Router off"). Rephrase ("move the clock to the top right"), run the model on a Mac, or force it with `llm.router: true` |
| IRIS never hears you | Find your mic with `arecord -l`, set `audio.micDevice: "plughw:CARD,0"`, test with `arecord -D plughw:1,0 -f S16_LE -r 16000 test.wav` |
| IRIS triggers on background noise | Raise `audio.vadThreshold` (e.g. 900); turn on `debug` to see what it hears |
| IRIS cuts you off mid-sentence | Raise `audio.pauseMs` (e.g. 500) or set it to `0`, and/or raise `audio.silenceMs` |
| Wake word misheard | Add the mis-hearing to `wakeWordAliases` (turn on `debug` to see transcripts) |
| No sound | `aplay -l`, then set `audio.speakerDevice`; test with `speaker-test -t wav -c 2` |
| "Camera … no capture tool found" | Pi camera: `rpicam-still --list-cameras`. USB: `sudo apt install fswebcam` |
| Outfits ignore the weather | Add MagicMirror's `weather` module or set `weather.latitude/longitude` |
| Slow answers | Keep `fastIntents: true` and `outfitPlanner: "fast"`, use `qwen3.5:2b`, or run the model on a Mac. Turn on `debug` to see which server answered and the prompt and generation times for every request |
| The Mac isn't used | From the Pi: `curl http://macbook.local:11434/api/version`. If that fails, check the Mac is awake, on the same network, and was set up with `--share` |

## Coming from "Jarvis"

The assistant is now **IRIS**. Updating is a `git pull`; then:

1. **The wake word is "Iris".** If your `config.js` sets `wakeWord: "jarvis"` (the old sample did),
   remove it, along with `assistantName` and `wakeWordAliases`. You can also keep it: any wake word
   works.
2. **Re-run the setup script** (`scripts/setup-pi.sh` or `scripts/setup-mac.sh`). It does the following:
   - Moves `~/.local/share/jarvis` to `~/.local/share/iris`, and leaves a link so old paths still work.
   - Renames the `jarvis-*` services and LaunchAgents to `iris-*`.
   - Switches the default Piper voice to `en_US-lessac-medium`.
   - On a Mac, installs the Kokoro voice.
3. **Notifications** are now `IRIS_*`; the old `JARVIS_ASK` / `JARVIS_STOP` still work.

The module folder stays `MMM-AI-Jarvis`, so your `config.js` entry doesn't change otherwise.

**From v2 (Google Cloud):** version 3 replaced Google Cloud (Speech, TTS, Vertex AI) with local
models, because Google retired the `gemini-1.5` models and the Vertex AI SDK that v2 used.

1. Run the setup script.
2. Remove these options from your config: `projectId`, `location`, `model`, `serviceAccountFile`,
   `ttsVoice` and `speechLanguage`. They're ignored, with a warning.
3. These still work and are mapped to the new options: `activationKeyword`, `showTranscription`,
   `showResponse`, `responseTimeout` and `maxTokens`.
4. Delete `credentials.json` and the old `node_modules/`; there are no npm dependencies now.

## Development

```bash
npm test          # node:test suite – no MagicMirror, models or hardware needed
```

```
MMM-AI-Jarvis/
├── MMM-AI-Jarvis.js        # Front-end: status orb, conversation, live cards, module control
├── MMM-AI-Jarvis.css       # Mirror-friendly styles and animations (rem-based, follows MagicMirror's type scale)
├── cards.js                # Animated data cards: weather, markets, news, facts, clocks, countdowns, sun, briefing
├── director.js             # Whole-mirror control in the browser: move, resize, text size, brightness, night mode
├── node_helper.js          # Bridge between the mirror and the engine; serves wardrobe photos
├── lib/
│   ├── Iris.js             # Orchestrator: mic → VAD → STT → wake word → assistant → TTS; echo suppression
│   ├── Assistant.js        # Conversation, system prompt, fast intents, LLM tool loop
│   ├── intents.js          # Deterministic routing for common requests
│   ├── Router.js           # Model-based routing for free-form requests (on fast servers)
│   ├── tools.js            # Tool definitions exposed to the LLM
│   ├── Skills.js           # Everything IRIS can do (vision, outfits, scores, timers, screen…)
│   ├── Clock.js            # Time & date reasoning: time zones, countdowns, holidays, birthdays
│   ├── OutfitPlanner.js    # Instant rule-based outfit picks (weather, occasion, likes, recent wear)
│   ├── Weather.js          # Open-Meteo / MagicMirror weather, hourly windows, any city
│   ├── InfoSkills.js       # Facts, news, markets, currency, definitions, maths, weather/time/sun cards, briefing
│   ├── Proactive.js        # Morning briefing, rain alerts, team alerts, quiet hours
│   ├── data/               # Wikipedia, Google News, Yahoo Finance, Frankfurter, dictionary, calculator
│   ├── Sports.js           # ESPN public scoreboards, natural score sentences
│   ├── Widgets.js          # Live cards with expiry and self-refresh
│   ├── Screen.js           # Knows and controls other modules on the mirror; layouts and saved scenes
│   ├── DisplaySkills.js    # Spoken replies for display control ("Done. The calendar is in the top left now.")
│   ├── Ollama.js           # Local LLM client (capability-aware, multi-server)
│   ├── ServerPool.js       # Health-checked failover between servers (Mac → Pi)
│   ├── Wardrobe.js, Memory.js, JsonStore.js, Camera.js, WebSearch.js
│   ├── speech/             # verbalize (written → spoken form), talk (natural times), weatherTalk
│   ├── audio/              # Microphone, voice activity detector, speech queue, speaker, WAV/chime
│   ├── stt/                # whisper.cpp client
│   └── tts/                # Kokoro, Piper (server + CLI), espeak-ng, and the fallback chain
├── docs/                   # Screenshots
├── scripts/setup-pi.sh     # Installs the local AI stack on a Raspberry Pi
├── scripts/setup-mac.sh    # Installs it on an Apple Silicon Mac (mirror computer or brain)
├── scripts/kokoro_server.py # Kokoro voice server (same HTTP API as Piper's)
├── config/config.js.sample
└── test/
```

## License

MIT
