#!/usr/bin/env bash
#
# MMM-AI-Jarvis — local AI stack installer
#
# Installs everything Jarvis needs to run fully on-device, with no cloud APIs:
#   • Ollama + a vision/tool-capable model    (the "brain" and the eyes)
#   • whisper.cpp server as a systemd service  (speech-to-text)
#   • Piper voice server as a systemd service  (text-to-speech)
#   • ALSA utils, espeak-ng, fswebcam          (mic/speaker, fallback voice, USB webcam)
#
# Supported targets: Raspberry Pi OS 64-bit (Bookworm/Trixie) on Pi 5 / Pi 4,
# and Debian/Ubuntu x86_64. Re-running is safe; finished steps are skipped.
#
# Usage: scripts/setup-pi.sh [options]
#   --model NAME          Ollama model (default: qwen3.5:2b, the fastest; qwen3.5:4b is smarter but slower)
#   --whisper-model NAME  whisper.cpp model (default: tiny.en, the fastest; base.en for noisy rooms;
#                         "tiny" or "base" for languages other than English)
#   --voice NAME          Piper voice (default: en_GB-alan-medium)
#   --whisper-port PORT   Port for the whisper server (default: 8178)
#   --piper-port PORT     Port for the Piper voice server (default: 5005)
#   --brain HOST          A Mac (or PC) on your network set up with setup-mac.sh --share,
#                         e.g. macbook.local. Jarvis uses it first and falls back to this Pi.
#   --no-ollama           Skip Ollama on the Pi (no local fallback when the brain is off)
#   --no-whisper          Skip whisper.cpp
#   --no-piper            Skip Piper
#   -h, --help            Show this help

set -euo pipefail

MODEL="qwen3.5:2b"
WHISPER_MODEL="tiny.en"
VOICE="en_GB-alan-medium"
WHISPER_PORT=8178
PIPER_PORT=5005
DO_OLLAMA=1
DO_WHISPER=1
DO_PIPER=1
BRAIN=""

JARVIS_HOME="${HOME}/.local/share/jarvis"
WHISPER_DIR="${JARVIS_HOME}/whisper.cpp"
PIPER_VENV="${JARVIS_HOME}/piper-venv"
VOICE_DIR="${JARVIS_HOME}/voices"

bold() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
warn() { printf '\033[33m    ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31mError: %s\033[0m\n' "$*" >&2; exit 1; }

usage() { sed -n '2,/^$/p' "$0" | sed 's/^# \{0,1\}//'; exit 0; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model)         MODEL="${2:?}"; shift 2 ;;
    --whisper-model) WHISPER_MODEL="${2:?}"; shift 2 ;;
    --voice)         VOICE="${2:?}"; shift 2 ;;
    --whisper-port)  WHISPER_PORT="${2:?}"; shift 2 ;;
    --piper-port)    PIPER_PORT="${2:?}"; shift 2 ;;
    --brain)         BRAIN="${2:?}"; shift 2 ;;
    --no-ollama)     DO_OLLAMA=0; shift ;;
    --no-whisper)    DO_WHISPER=0; shift ;;
    --no-piper)      DO_PIPER=0; shift ;;
    -h|--help)       usage ;;
    *)               die "Unknown option: $1 (see --help)" ;;
  esac
done

# Install or update a systemd service running as the current user.
install_service() {
  local name="$1" description="$2" exec_start="$3"
  sudo tee "/etc/systemd/system/${name}.service" >/dev/null <<EOF
[Unit]
Description=${description}
After=network.target

[Service]
User=${USER}
ExecStart=${exec_start}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable "$name" >/dev/null 2>&1
  sudo systemctl restart "$name"
}

wait_for_http() {
  local url="$1" seconds="$2"
  for _ in $(seq 1 "$seconds"); do
    curl -fsS -o /dev/null "$url" 2>/dev/null && return 0
    sleep 1
  done
  return 1
}

# ── Pre-flight ────────────────────────────────────────────────────────────────

[[ $EUID -ne 0 ]] || die "Run this as your normal user (the one running MagicMirror), not root. It uses sudo when needed."
command -v sudo >/dev/null || die "sudo is required."

ARCH="$(uname -m)"
case "$ARCH" in
  aarch64|x86_64) ;;
  armv7l|armv6l) die "A 64-bit OS is required (Ollama has no 32-bit ARM build). Install Raspberry Pi OS 64-bit." ;;
  *) warn "Untested architecture: $ARCH" ;;
esac

MEM_GB=$(awk '/MemTotal/ { printf "%d", $2 / 1024 / 1024 + 0.5 }' /proc/meminfo)
if [[ "$MODEL" == *4b* || "$MODEL" == *9b* ]] && (( MEM_GB < 6 )); then
  warn "${MODEL} needs more RAM than this device has (${MEM_GB} GB). Consider --model qwen3.5:2b."
fi
THREADS=$(nproc)

bold "MMM-AI-Jarvis local setup"
info "RAM: ${MEM_GB} GB · CPU threads: ${THREADS} · Arch: ${ARCH}"
info "LLM: ${MODEL} · Whisper: ${WHISPER_MODEL} · Voice: ${VOICE}"
mkdir -p "$JARVIS_HOME" "$VOICE_DIR"

# ── System packages ───────────────────────────────────────────────────────────

bold "Installing system packages"
PKGS=(alsa-utils espeak-ng fswebcam curl ca-certificates zstd)
(( DO_WHISPER )) && PKGS+=(git cmake build-essential)
(( DO_PIPER )) && PKGS+=(python3-venv python3-pip)
sudo apt-get update -qq
sudo apt-get install -y -qq "${PKGS[@]}"

if command -v rpicam-still >/dev/null || command -v libcamera-still >/dev/null; then
  info "Raspberry Pi camera tools found."
else
  info "No Pi camera tools found; USB webcams will use fswebcam."
fi

# ── Ollama ────────────────────────────────────────────────────────────────────

if (( DO_OLLAMA )); then
  bold "Ollama"
  if ! command -v ollama >/dev/null; then
    info "Installing Ollama…"
    curl -fsSL https://ollama.com/install.sh | sh
  else
    info "Ollama already installed ($(ollama --version 2>/dev/null | tail -n1))."
  fi

  # One model in memory at a time keeps RAM predictable on a Pi.
  sudo mkdir -p /etc/systemd/system/ollama.service.d
  sudo tee /etc/systemd/system/ollama.service.d/jarvis.conf >/dev/null <<EOF
[Service]
Environment="OLLAMA_NUM_PARALLEL=1"
Environment="OLLAMA_MAX_LOADED_MODELS=1"
EOF
  sudo systemctl daemon-reload
  sudo systemctl enable ollama >/dev/null 2>&1 || true
  sudo systemctl restart ollama
  wait_for_http http://127.0.0.1:11434/api/tags 30 || die "Ollama did not start. Check: journalctl -u ollama"

  info "Pulling ${MODEL} (this can take a while)…"
  ollama pull "$MODEL"
fi

# ── whisper.cpp ───────────────────────────────────────────────────────────────

if (( DO_WHISPER )); then
  bold "whisper.cpp speech-to-text"
  if [[ -d "${WHISPER_DIR}/.git" ]]; then
    info "Updating whisper.cpp…"
    git -C "$WHISPER_DIR" pull --ff-only -q || warn "Could not update whisper.cpp; using the existing checkout."
  else
    git clone -q --depth 1 https://github.com/ggml-org/whisper.cpp.git "$WHISPER_DIR"
  fi

  info "Building whisper-server (a few minutes on a Pi)…"
  cmake -S "$WHISPER_DIR" -B "${WHISPER_DIR}/build" -DCMAKE_BUILD_TYPE=Release >/dev/null
  cmake --build "${WHISPER_DIR}/build" -j "$THREADS" --config Release --target whisper-server >/dev/null
  WHISPER_BIN="${WHISPER_DIR}/build/bin/whisper-server"
  [[ -x "$WHISPER_BIN" ]] || die "whisper-server was not built. See the cmake output above."

  WHISPER_MODEL_FILE="${WHISPER_DIR}/models/ggml-${WHISPER_MODEL}.bin"
  if [[ ! -f "$WHISPER_MODEL_FILE" ]]; then
    info "Downloading whisper model ${WHISPER_MODEL}…"
    bash "${WHISPER_DIR}/models/download-ggml-model.sh" "$WHISPER_MODEL" >/dev/null
  fi
  [[ -f "$WHISPER_MODEL_FILE" ]] || die "Whisper model download failed."

  info "Installing jarvis-whisper service on 127.0.0.1:${WHISPER_PORT}…"
  install_service jarvis-whisper "whisper.cpp speech-to-text server for MMM-AI-Jarvis" \
    "${WHISPER_BIN} -m ${WHISPER_MODEL_FILE} --host 127.0.0.1 --port ${WHISPER_PORT} -t ${THREADS}"
fi

# ── Piper ─────────────────────────────────────────────────────────────────────

if (( DO_PIPER )); then
  bold "Piper text-to-speech"
  [[ -x "${PIPER_VENV}/bin/python" ]] || python3 -m venv "$PIPER_VENV"
  "${PIPER_VENV}/bin/pip" install -q --upgrade pip
  # The [http] extra adds the persistent voice server (keeps the voice loaded: ~0.2s per sentence instead of ~3s).
  "${PIPER_VENV}/bin/pip" install -q --upgrade "piper-tts[http]"

  # Voice names look like en_GB-alan-medium → en/en_GB/alan/medium/
  IFS='-' read -r V_LOCALE V_NAME V_QUALITY <<<"$VOICE"
  [[ -n "${V_LOCALE:-}" && -n "${V_NAME:-}" && -n "${V_QUALITY:-}" ]] || die "Voice must look like en_GB-alan-medium."
  V_LANG="${V_LOCALE%%_*}"
  V_URL="https://huggingface.co/rhasspy/piper-voices/resolve/main/${V_LANG}/${V_LOCALE}/${V_NAME}/${V_QUALITY}/${VOICE}"

  for ext in onnx onnx.json; do
    if [[ ! -s "${VOICE_DIR}/${VOICE}.${ext}" ]]; then
      info "Downloading ${VOICE}.${ext}…"
      curl -fsSL -o "${VOICE_DIR}/${VOICE}.${ext}.part" "${V_URL}.${ext}?download=true" \
        || die "Could not download voice ${VOICE}. Browse voices at https://rhasspy.github.io/piper-samples/"
      mv "${VOICE_DIR}/${VOICE}.${ext}.part" "${VOICE_DIR}/${VOICE}.${ext}"
    fi
  done

  info "Installing jarvis-piper service on 127.0.0.1:${PIPER_PORT}…"
  install_service jarvis-piper "Piper voice server for MMM-AI-Jarvis" \
    "${PIPER_VENV}/bin/python -m piper.http_server -m ${VOICE_DIR}/${VOICE}.onnx --host 127.0.0.1 --port ${PIPER_PORT}"

  info "Testing the voice…"
  if wait_for_http "http://127.0.0.1:${PIPER_PORT}/" 30; then
    TEST_WAV="$(mktemp --suffix=.wav)"
    if curl -fsS -o "$TEST_WAV" -X POST "http://127.0.0.1:${PIPER_PORT}/synthesize" \
         -H 'Content-Type: application/json' -d '{"text": "Hello, I am Jarvis. Setup is almost done."}'; then
      aplay -q "$TEST_WAV" 2>/dev/null || warn "Voice works, but playback failed. Check your speaker with: speaker-test -t wav -c 2"
    else
      warn "The Piper server did not synthesise speech. Check: journalctl -u jarvis-piper"
    fi
    rm -f "$TEST_WAV"
  else
    warn "The Piper server did not start. Check: journalctl -u jarvis-piper (Jarvis will fall back to the piper CLI)."
  fi
fi

# ── Health summary ────────────────────────────────────────────────────────────

bold "Checking services"
if (( DO_OLLAMA )); then
  curl -fsS -o /dev/null http://127.0.0.1:11434/api/tags && info "Ollama ............ OK" || warn "Ollama ............ not responding"
fi
if (( DO_WHISPER )); then
  wait_for_http "http://127.0.0.1:${WHISPER_PORT}" 20 && info "whisper.cpp ....... OK" \
    || warn "whisper.cpp ....... not responding (journalctl -u jarvis-whisper)"
fi
if (( DO_PIPER )); then
  curl -fsS -o /dev/null "http://127.0.0.1:${PIPER_PORT}/" && info "Piper ............. OK" \
    || warn "Piper ............. not responding (journalctl -u jarvis-piper)"
fi
arecord -l 2>/dev/null | grep -q '^card' && info "Microphone ........ found" || warn "Microphone ........ none found (arecord -l)"

LANG_CODE="en"
[[ "$WHISPER_MODEL" == *.en ]] || LANG_CODE="${V_LANG:-en}"

if [[ -n "$BRAIN" ]]; then
  if curl -fsS -o /dev/null --max-time 3 "http://${BRAIN}:11434/api/version"; then
    info "Brain at ${BRAIN} ..... OK"
  else
    warn "Can't reach Ollama on ${BRAIN} yet. Run scripts/setup-mac.sh --share on it."
  fi
  LOCAL_LLM=""
  if (( DO_OLLAMA )); then
    LOCAL_LLM=$'\n'"          { url: \"http://127.0.0.1:11434\", model: \"${MODEL}\" },"
  fi
  BRAIN_CONFIG="      stt: { whisperUrl: [\"http://${BRAIN}:8178\", \"http://127.0.0.1:${WHISPER_PORT}\"] },
      tts: {
        piperUrl: [\"http://${BRAIN}:5005\", \"http://127.0.0.1:${PIPER_PORT}\"],
        piperModel: \"${VOICE_DIR}/${VOICE}.onnx\",
      },
      llm: {
        servers: [
          { url: \"http://${BRAIN}:11434\", model: \"qwen3.5:4b\" },${LOCAL_LLM}
        ],
      },"
else
  BRAIN_CONFIG="      stt: { whisperUrl: \"http://127.0.0.1:${WHISPER_PORT}\" },
      tts: {
        piperUrl: \"http://127.0.0.1:${PIPER_PORT}\",
        piperCommand: \"${PIPER_VENV}/bin/piper\",
        piperModel: \"${VOICE_DIR}/${VOICE}.onnx\",
      },
      llm: { model: \"${MODEL}\" },"
fi

bold "Done! Add this to the modules array in ~/MagicMirror/config/config.js:"
cat <<EOF

  {
    module: "MMM-AI-Jarvis",
    position: "lower_third",
    config: {
      language: "${LANG_CODE}",
${BRAIN_CONFIG}
    },
  },

Then restart MagicMirror and say "Jarvis, what should I wear today?"
EOF
