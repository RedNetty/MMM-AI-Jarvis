#!/usr/bin/env bash
#
# MMM-AI-Jarvis (IRIS) — Apple Silicon Mac installer
#
# Sets up the local AI stack on an M1/M2/M3/M4 Mac, using its GPU (Metal):
#   • Ollama + a vision/tool-capable model    (the "brain" and the eyes)
#   • whisper.cpp server, built with Metal     (speech-to-text)
#   • Kokoro voice server                      (natural text-to-speech)
#   • Piper voice server                       (fast fallback voice)
#   • ffmpeg                                   (microphone and camera on macOS)
# Each runs as a LaunchAgent: it starts when you log in and restarts if it stops.
#
# Two ways to use the Mac:
#   1. The Mac IS the mirror computer: run MagicMirror on it and connect the
#      mirror's display (a broken built-in screen doesn't matter).  → default
#   2. The Mac is the "brain" for a Raspberry Pi mirror: the Pi sends speech,
#      questions and text-to-speech here over your network.          → --share
#
# Usage: scripts/setup-mac.sh [options]
#   --share               Listen on your network so a Raspberry Pi can use this Mac
#   --model NAME          Ollama model (default: qwen3.5:4b; qwen3.5:9b on 16 GB+ Macs)
#   --whisper-model NAME  whisper.cpp model (default: base.en; "base" for other languages)
#   --kokoro-voice NAME   Kokoro voice (default: af_heart; also af_bella, am_michael, bf_emma, bm_george…)
#   --voice NAME          Piper fallback voice (default: en_US-lessac-medium)
#   --no-kokoro           Skip Kokoro and use Piper as the voice
#   --keep-sleep          Don't change the Mac's sleep settings
#   -h, --help            Show this help
#
# Re-running is safe. An install made under the old "Jarvis" name is moved over.
# Written for macOS 13 (Ventura) or newer, and macOS's built-in bash 3.2.

set -euo pipefail

SHARE=0
MODEL="qwen3.5:4b"
WHISPER_MODEL="base.en"
VOICE="en_US-lessac-medium"
KOKORO_VOICE="af_heart"
DO_KOKORO=1
KEEP_SLEEP=0
OLLAMA_PORT=11434
WHISPER_PORT=8178
PIPER_PORT=5005
KOKORO_PORT=5006

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# Same layout as on the Pi (and no spaces in paths, which some build scripts dislike).
IRIS_HOME="${HOME}/.local/share/iris"
LEGACY_HOME="${HOME}/.local/share/jarvis"
WHISPER_DIR="${IRIS_HOME}/whisper.cpp"
PIPER_VENV="${IRIS_HOME}/piper-venv"
VOICE_DIR="${IRIS_HOME}/voices"
KOKORO_DIR="${IRIS_HOME}/kokoro"
KOKORO_VENV="${IRIS_HOME}/kokoro-venv"
KOKORO_RELEASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
AGENTS="${HOME}/Library/LaunchAgents"
LOGS="${HOME}/Library/Logs"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [ $# -gt 0 ]; do
  case "$1" in
    --share)         SHARE=1; shift ;;
    --model)         MODEL="${2:?}"; shift 2 ;;
    --whisper-model) WHISPER_MODEL="${2:?}"; shift 2 ;;
    --voice)         VOICE="${2:?}"; shift 2 ;;
    --kokoro-voice)  KOKORO_VOICE="${2:?}"; shift 2 ;;
    --no-kokoro)     DO_KOKORO=0; shift ;;
    --keep-sleep)    KEEP_SLEEP=1; shift ;;
    -h|--help)       usage ;;
    *)               die "Unknown option: $1 (see --help)" ;;
  esac
done

if [ "$SHARE" -eq 1 ]; then HOST="0.0.0.0"; else HOST="127.0.0.1"; fi

# Write a LaunchAgent and (re)load it.  $1 = label, $2 = log name, rest = program arguments.
# Environment variables come from the AGENT_ENV string ("KEY=value" lines).
install_agent() {
  local label="$1" logname="$2"
  shift 2
  local plist="${AGENTS}/${label}.plist"
  mkdir -p "$AGENTS" "$LOGS"
  {
    echo '<?xml version="1.0" encoding="UTF-8"?>'
    echo '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
    echo '<plist version="1.0"><dict>'
    echo "  <key>Label</key><string>${label}</string>"
    echo '  <key>ProgramArguments</key><array>'
    local arg
    for arg in "$@"; do echo "    <string>${arg}</string>"; done
    echo '  </array>'
    if [ -n "${AGENT_ENV:-}" ]; then
      echo '  <key>EnvironmentVariables</key><dict>'
      local line
      while IFS= read -r line; do
        [ -n "$line" ] || continue
        echo "    <key>${line%%=*}</key><string>${line#*=}</string>"
      done <<EOF
${AGENT_ENV}
EOF
      echo '  </dict>'
    fi
    echo '  <key>RunAtLoad</key><true/>'
    echo '  <key>KeepAlive</key><true/>'
    echo '  <key>ProcessType</key><string>Interactive</string>'
    echo "  <key>StandardOutPath</key><string>${LOGS}/${logname}.log</string>"
    echo "  <key>StandardErrorPath</key><string>${LOGS}/${logname}.log</string>"
    echo '</dict></plist>'
  } > "$plist"
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$plist"
}

# Stop and remove a LaunchAgent (used for the agents of the old "Jarvis" install).
remove_agent() {
  local plist="${AGENTS}/$1.plist"
  [ -f "$plist" ] || return 0
  launchctl bootout "gui/$(id -u)" "$plist" >/dev/null 2>&1 || true
  rm -f "$plist"
  info "Removed old agent $1"
}

wait_for_http() {
  local url="$1" seconds="$2" i=0
  while [ "$i" -lt "$seconds" ]; do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
    i=$((i + 1))
  done
  return 1
}

port_in_use_by_other() {
  # True when something other than our own agent already listens on the port.
  lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

download() {
  # $1 = URL, $2 = destination. Downloads via a .part file so an interrupted run is retried.
  [ -s "$2" ] && return 0
  info "Downloading $(basename "$2")…"
  curl -fsSL -o "$2.part" "$1" || return 1
  mv "$2.part" "$2"
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

[ "$(uname -s)" = "Darwin" ] || die "This script is for macOS. On a Raspberry Pi use scripts/setup-pi.sh."
[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not with sudo. It asks for your password when needed."
if [ "$(uname -m)" != "arm64" ]; then
  warn "This is an Intel Mac: there is no Metal acceleration for Ollama, so it will be much slower than Apple Silicon."
fi

MEM_GB=$(( $(sysctl -n hw.memsize) / 1024 / 1024 / 1024 ))
CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null || echo "unknown chip")
THREADS=$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || sysctl -n hw.physicalcpu)
case "$MODEL" in
  *9b*|*27b*) [ "$MEM_GB" -ge 16 ] || warn "${MODEL} needs more memory than this Mac has (${MEM_GB} GB). Consider --model qwen3.5:4b." ;;
esac

bold "IRIS Mac setup (MMM-AI-Jarvis)"
info "${CHIP} · ${MEM_GB} GB memory · macOS $(sw_vers -productVersion)"
if [ "$DO_KOKORO" -eq 1 ]; then VOICE_SUMMARY="Kokoro ${KOKORO_VOICE} (Piper ${VOICE} as fallback)"; else VOICE_SUMMARY="Piper ${VOICE}"; fi
info "LLM: ${MODEL} · Whisper: ${WHISPER_MODEL} · Voice: ${VOICE_SUMMARY}"
if [ "$SHARE" -eq 1 ]; then info "Sharing with a Raspberry Pi on your network (listening on all interfaces)."; fi

if ! xcode-select -p >/dev/null 2>&1; then
  xcode-select --install || true
  die "Install the Xcode Command Line Tools in the window that just opened, then run this script again."
fi
command -v brew >/dev/null 2>&1 || die 'Homebrew is required. Install it from https://brew.sh then run this script again.'

# ── Move an install made under the old name ───────────────────────────────────

for old in com.jarvis.ollama com.jarvis.whisper com.jarvis.piper; do remove_agent "$old"; done
if [ -d "$LEGACY_HOME" ] && [ ! -L "$LEGACY_HOME" ] && [ ! -e "$IRIS_HOME" ]; then
  bold "Moving ${LEGACY_HOME} to ${IRIS_HOME}"
  mkdir -p "$(dirname "$IRIS_HOME")"
  mv "$LEGACY_HOME" "$IRIS_HOME"
  ln -s "$IRIS_HOME" "$LEGACY_HOME"  # old config paths keep working
  # The whisper build caches its own path; rebuild from a clean tree below.
  rm -rf "${WHISPER_DIR}/build"
fi
mkdir -p "$IRIS_HOME" "$VOICE_DIR" "$KOKORO_DIR"

# ── Packages ──────────────────────────────────────────────────────────────────

bold "Installing packages with Homebrew"
BREW_PKGS="ollama cmake git ffmpeg python@3.12"
# Kokoro's phonemizer is most reliable with a system espeak-ng.
[ "$DO_KOKORO" -eq 1 ] && BREW_PKGS="${BREW_PKGS} espeak-ng"
# shellcheck disable=SC2086
brew install $BREW_PKGS >/dev/null
BREW_PREFIX="$(brew --prefix)"
PYTHON="$(brew --prefix python@3.12)/bin/python3.12"
OLLAMA_BIN="${BREW_PREFIX}/opt/ollama/bin/ollama"
[ -x "$OLLAMA_BIN" ] || OLLAMA_BIN="$(command -v ollama)"

# ── Ollama ────────────────────────────────────────────────────────────────────

bold "Ollama (Metal)"
# IRIS runs its own agent so it can listen on the network and keep the model loaded.
brew services stop ollama >/dev/null 2>&1 || true
if [ ! -f "${AGENTS}/com.iris.ollama.plist" ] && port_in_use_by_other "$OLLAMA_PORT"; then
  die "Something is already using port ${OLLAMA_PORT} (probably the Ollama app). Quit it (and remove it from Login Items), then run this script again."
fi
AGENT_ENV="OLLAMA_HOST=${HOST}:${OLLAMA_PORT}
OLLAMA_KEEP_ALIVE=-1
OLLAMA_FLASH_ATTENTION=1
OLLAMA_NUM_PARALLEL=1
OLLAMA_MAX_LOADED_MODELS=1"
install_agent com.iris.ollama iris-ollama "$OLLAMA_BIN" serve
AGENT_ENV=""
wait_for_http "http://127.0.0.1:${OLLAMA_PORT}/api/version" 30 || die "Ollama did not start. See ${LOGS}/iris-ollama.log"
info "Pulling ${MODEL}…"
OLLAMA_HOST="127.0.0.1:${OLLAMA_PORT}" "$OLLAMA_BIN" pull "$MODEL"

# ── whisper.cpp ───────────────────────────────────────────────────────────────

bold "whisper.cpp speech-to-text (Metal)"
if [ -d "${WHISPER_DIR}/.git" ]; then
  git -C "$WHISPER_DIR" pull --ff-only -q || warn "Could not update whisper.cpp; using the existing checkout."
else
  git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
fi
info "Building whisper-server…"
cmake -S "$WHISPER_DIR" -B "${WHISPER_DIR}/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
cmake --build "${WHISPER_DIR}/build" -j "$(sysctl -n hw.ncpu)" --config Release --target whisper-server >/dev/null
WHISPER_BIN="${WHISPER_DIR}/build/bin/whisper-server"
[ -x "$WHISPER_BIN" ] || die "whisper-server was not built. See the cmake output above."

WHISPER_MODEL_FILE="${WHISPER_DIR}/models/ggml-${WHISPER_MODEL}.bin"
if [ ! -f "$WHISPER_MODEL_FILE" ]; then
  info "Downloading whisper model ${WHISPER_MODEL}…"
  bash "${WHISPER_DIR}/models/download-ggml-model.sh" "$WHISPER_MODEL" >/dev/null
fi
[ -f "$WHISPER_MODEL_FILE" ] || die "Whisper model download failed."
install_agent com.iris.whisper iris-whisper "$WHISPER_BIN" -m "$WHISPER_MODEL_FILE" --host "$HOST" --port "$WHISPER_PORT" -t "$THREADS"

# ── Kokoro (natural voice) ────────────────────────────────────────────────────

if [ "$DO_KOKORO" -eq 1 ]; then
  bold "Kokoro natural voice"
  [ -x "${KOKORO_VENV}/bin/python" ] || "$PYTHON" -m venv "$KOKORO_VENV"
  "${KOKORO_VENV}/bin/pip" install -q --upgrade pip
  "${KOKORO_VENV}/bin/pip" install -q --upgrade kokoro-onnx
  # The int8 model is a quarter the size and sounds the same at mirror distance.
  download "${KOKORO_RELEASE}/kokoro-v1.0.int8.onnx" "${KOKORO_DIR}/kokoro-v1.0.int8.onnx" || die "Could not download the Kokoro model."
  download "${KOKORO_RELEASE}/voices-v1.0.bin" "${KOKORO_DIR}/voices-v1.0.bin" || die "Could not download the Kokoro voices."
  # A private copy, so moving or updating the module never breaks the running agent.
  cp "${SCRIPT_DIR}/kokoro_server.py" "${KOKORO_DIR}/kokoro_server.py"
  install_agent com.iris.kokoro iris-kokoro "${KOKORO_VENV}/bin/python" "${KOKORO_DIR}/kokoro_server.py" \
    --model "${KOKORO_DIR}/kokoro-v1.0.int8.onnx" --voices "${KOKORO_DIR}/voices-v1.0.bin" \
    --host "$HOST" --port "$KOKORO_PORT" --voice "$KOKORO_VOICE"
else
  remove_agent com.iris.kokoro
fi

# ── Piper (fallback voice) ────────────────────────────────────────────────────

bold "Piper text-to-speech"
[ -x "${PIPER_VENV}/bin/python" ] || "$PYTHON" -m venv "$PIPER_VENV"
"${PIPER_VENV}/bin/pip" install -q --upgrade pip
"${PIPER_VENV}/bin/pip" install -q --upgrade "piper-tts[http]"

V_LOCALE="${VOICE%%-*}"
V_REST="${VOICE#*-}"
V_NAME="${V_REST%%-*}"
V_QUALITY="${V_REST#*-}"
V_LANG="${V_LOCALE%%_*}"
[ -n "$V_NAME" ] && [ "$V_QUALITY" != "$V_REST" ] || die "Voice must look like en_US-lessac-medium."
V_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/${V_LANG}/${V_LOCALE}/${V_NAME}/${V_QUALITY}/${VOICE}"
for ext in onnx onnx.json; do
  download "${V_URL}.${ext}?download=true" "${VOICE_DIR}/${VOICE}.${ext}" \
    || die "Could not download voice ${VOICE}. Browse voices at https://rhasspy.github.io/piper-samples/"
done
install_agent com.iris.piper iris-piper "${PIPER_VENV}/bin/python" -m piper.http_server \
  -m "${VOICE_DIR}/${VOICE}.onnx" --host "$HOST" --port "$PIPER_PORT"

# ── Power & network ───────────────────────────────────────────────────────────

if [ "$KEEP_SLEEP" -eq 0 ]; then
  bold "Keeping the Mac awake"
  info "A mirror computer must not sleep. This needs your password:"
  # On power: never sleep (screen may turn off), wake for network access.
  sudo pmset -c sleep 0 disksleep 0 displaysleep 1 womp 1
  # Also stay awake with the lid closed. Undo with: sudo pmset -a disablesleep 0
  sudo pmset -a disablesleep 1
fi

if [ "$SHARE" -eq 1 ]; then
  FW=/usr/libexec/ApplicationFirewall/socketfilterfw
  if "$FW" --getglobalstate 2>/dev/null | grep -q "enabled"; then
    bold "Allowing the Pi through the macOS firewall"
    PY_BIN="$("${PIPER_VENV}/bin/python" -c 'import sys, os; print(os.path.realpath(sys.executable))')"
    for bin in "$OLLAMA_BIN" "$WHISPER_BIN" "$PY_BIN"; do
      sudo "$FW" --add "$bin" >/dev/null
      sudo "$FW" --unblockapp "$bin" >/dev/null
    done
  fi
fi

# ── Health summary ────────────────────────────────────────────────────────────

bold "Checking services"
wait_for_http "http://127.0.0.1:${OLLAMA_PORT}/api/version" 10 && info "Ollama ............ OK" || warn "Ollama ............ not responding (${LOGS}/iris-ollama.log)"
wait_for_http "http://127.0.0.1:${WHISPER_PORT}" 30 && info "whisper.cpp ....... OK" || warn "whisper.cpp ....... not responding (${LOGS}/iris-whisper.log)"
wait_for_http "http://127.0.0.1:${PIPER_PORT}/" 60 && info "Piper ............. OK" || warn "Piper ............. not responding (${LOGS}/iris-piper.log)"
SPEAK_PORT="$PIPER_PORT"
if [ "$DO_KOKORO" -eq 1 ]; then
  if wait_for_http "http://127.0.0.1:${KOKORO_PORT}/" 90; then
    info "Kokoro ............ OK"
    SPEAK_PORT="$KOKORO_PORT"
  else
    warn "Kokoro ............ not responding (${LOGS}/iris-kokoro.log); Piper will speak instead."
  fi
fi

if wait_for_http "http://127.0.0.1:${SPEAK_PORT}/" 1; then
  TEST_WAV="$(mktemp -t iris).wav"
  if curl -fsS -o "$TEST_WAV" -X POST "http://127.0.0.1:${SPEAK_PORT}/synthesize" \
       -H 'Content-Type: application/json' -d '{"text": "Hi, I am Iris. Setup is almost done."}'; then
    afplay "$TEST_WAV" || true
  fi
  rm -f "$TEST_WAV"
fi

LANG_CODE="en"
case "$WHISPER_MODEL" in *.en) ;; *) LANG_CODE="${V_LANG:-en}" ;; esac
MAC_HOST="$(scutil --get LocalHostName 2>/dev/null || hostname -s).local"

bold "Done!"
if [ "$SHARE" -eq 1 ]; then
  if [ "$DO_KOKORO" -eq 1 ]; then
    PI_TTS="    tts: { provider: \"kokoro\", kokoroUrl: \"http://${MAC_HOST}:${KOKORO_PORT}\", piperUrl: \"http://127.0.0.1:5005\" },"
  else
    PI_TTS="    tts: { piperUrl: [\"http://${MAC_HOST}:${PIPER_PORT}\", \"http://127.0.0.1:5005\"] },"
  fi
  cat <<EOF

On the Raspberry Pi, add this to the MMM-AI-Jarvis config in ~/MagicMirror/config/config.js.
The Pi's own services stay as a fallback for when this Mac is off.

    stt: { whisperUrl: ["http://${MAC_HOST}:${WHISPER_PORT}", "http://127.0.0.1:8178"] },
${PI_TTS}
    llm: {
      servers: [
        { url: "http://${MAC_HOST}:${OLLAMA_PORT}", model: "${MODEL}" },
        { url: "http://127.0.0.1:11434", model: "qwen3.5:2b" },
      ],
    },

Check from the Pi:  curl http://${MAC_HOST}:${OLLAMA_PORT}/api/version
These services have no password: only use --share on a home network you trust.
EOF
else
  if [ "$DO_KOKORO" -eq 1 ]; then
    MAC_TTS="      tts: { provider: \"kokoro\", kokoroUrl: \"http://127.0.0.1:${KOKORO_PORT}\", piperModel: \"${VOICE_DIR}/${VOICE}.onnx\" },"
  else
    MAC_TTS="      tts: { piperModel: \"${VOICE_DIR}/${VOICE}.onnx\" },"
  fi
  cat <<EOF

To run the mirror on this Mac, add this to the modules array in ~/MagicMirror/config/config.js:

  {
    module: "MMM-AI-Jarvis",
    position: "lower_third",
    config: {
      language: "${LANG_CODE}",
      llm: { model: "${MODEL}" },
${MAC_TTS}
    },
  },

If your config still has wakeWord: "jarvis" from before, remove it (or set "iris").
The first time MagicMirror starts, macOS asks for microphone and camera access: allow it.
Then restart MagicMirror and say "Iris, what should I wear today?"
EOF
fi
