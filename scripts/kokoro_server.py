#!/usr/bin/env python3
"""Kokoro voice server for MMM-AI-Jarvis (IRIS).

Kokoro-82M (https://huggingface.co/hexgrad/Kokoro-82M) sounds far more natural
than Piper and still runs locally: about 0.2 s per sentence on an Apple
Silicon Mac. A Raspberry Pi is too slow for it, so the Pi keeps Piper as its
voice and uses this server while the Mac is on.

It speaks the same small HTTP API as Piper's server, so the module talks to
both the same way:

    GET  /                       health check
    GET  /voices                 installed voice names
    POST /synthesize             {"text": "...", "voice"?: "af_heart", "speed"?: 1.0} -> audio/wav
    POST /v1/audio/speech        OpenAI-style {"input": "...", "voice"?: ..., "speed"?: ...} -> audio/wav

Usage:
    python kokoro_server.py --model kokoro-v1.0.int8.onnx --voices voices-v1.0.bin \
        [--host 127.0.0.1] [--port 5006] [--voice af_heart] [--speed 1.0]
"""

import argparse
import glob
import io
import json
import os
import sys
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def use_system_espeak():
    """Prefer a system espeak-ng library when one is installed.

    The espeak-ng copy bundled with kokoro-onnx has a build-machine data path
    baked in, which some phonemizer releases fail to override. A system
    install (apt install espeak-ng / brew install espeak-ng) always works.
    """
    if os.environ.get("PHONEMIZER_ESPEAK_LIBRARY"):
        return
    candidates = (
        glob.glob("/opt/homebrew/lib/libespeak-ng*.dylib")
        + glob.glob("/usr/local/lib/libespeak-ng*.dylib")
        + glob.glob("/usr/lib/*/libespeak-ng.so.1")
        + glob.glob("/usr/lib/libespeak-ng.so.1")
    )
    if candidates:
        os.environ["PHONEMIZER_ESPEAK_LIBRARY"] = candidates[0]


def to_wav(samples, sample_rate):
    """float32 samples in [-1, 1] -> 16-bit mono WAV bytes."""
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sample_rate)
        w.writeframes(pcm)
    return buf.getvalue()


class Voice:
    def __init__(self, model, voices, voice, speed, lang):
        use_system_espeak()
        from kokoro_onnx import Kokoro

        started = time.time()
        self.kokoro = Kokoro(model, voices)
        self.voice = voice
        self.speed = speed
        self.lang = lang
        self.lock = threading.Lock()  # one synthesis at a time: it uses every core anyway
        self.names = sorted(self.kokoro.get_voices())
        if voice not in self.names:
            sys.exit(f"Unknown voice {voice!r}. Installed: {', '.join(self.names)}")
        self.synthesize("Ready.")  # warm up so the first real sentence is fast
        print(f"Kokoro loaded in {time.time() - started:.1f}s (voice {voice})", flush=True)

    def synthesize(self, text, voice=None, speed=None):
        voice = voice if voice in self.names else self.voice
        speed = float(speed) if speed else self.speed
        lang = "en-gb" if voice.startswith("b") else self.lang
        with self.lock:
            samples, rate = self.kokoro.create(text, voice=voice, speed=speed, lang=lang)
        return to_wav(samples, rate)


def make_handler(voice):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):  # quiet; errors are still reported below
            pass

        def _send(self, status, body, content_type):
            self.send_response(status)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _json(self, status, obj):
            self._send(status, json.dumps(obj).encode(), "application/json")

        def do_GET(self):
            if self.path == "/":
                self._json(200, {"ok": True, "engine": "kokoro", "voice": voice.voice})
            elif self.path == "/voices":
                self._json(200, voice.names)
            else:
                self._json(404, {"error": "not found"})

        def do_POST(self):
            if self.path not in ("/synthesize", "/v1/audio/speech"):
                self._json(404, {"error": "not found"})
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"{}")
                text = str(body.get("text") or body.get("input") or "").strip()
                if not text:
                    self._json(400, {"error": "text is required"})
                    return
                started = time.time()
                wav = voice.synthesize(text[:2000], body.get("voice"), body.get("speed"))
                self._send(200, wav, "audio/wav")
                print(f"{time.time() - started:.2f}s  {text[:60]!r}", flush=True)
            except Exception as err:  # keep serving after a bad request
                print(f"Synthesis failed: {err}", file=sys.stderr, flush=True)
                self._json(500, {"error": str(err)})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--model", required=True, help="kokoro-v1.0(.int8).onnx")
    parser.add_argument("--voices", required=True, help="voices-v1.0.bin")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=5006)
    parser.add_argument("--voice", default="af_heart", help="e.g. af_heart, af_bella, am_michael, bf_emma, bm_george")
    parser.add_argument("--speed", type=float, default=1.0)
    parser.add_argument("--lang", default="en-us")
    args = parser.parse_args()

    voice = Voice(args.model, args.voices, args.voice, args.speed, args.lang)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(voice))
    print(f"Kokoro voice server on http://{args.host}:{args.port}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
