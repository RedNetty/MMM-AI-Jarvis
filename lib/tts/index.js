"use strict";

/**
 * Text-to-speech factory.
 * Every engine exposes: name, synthesize(text) → Promise<Buffer wav>, healthCheck() → Promise<string|null>,
 * and optionally start(), stop(), `available` and `robotic`.
 */

/** Where setup-mac.sh runs the Kokoro server when IRIS and Kokoro share a machine. */
const LOCAL_KOKORO = "http://127.0.0.1:5006";

function kokoro(tts, url) {
  const KokoroTTS = require("./KokoroTTS");
  return new KokoroTTS({ url, voice: tts.kokoroVoice, speed: tts.kokoroSpeed });
}

function piper(tts) {
  const PiperTTS = require("./PiperTTS");
  return new PiperTTS({
    url: tts.piperUrl,
    command: tts.piperCommand,
    model: tts.piperModel,
    speaker: tts.piperSpeaker,
    lengthScale: tts.piperLengthScale,
    extraArgs: tts.piperArgs,
  });
}

function espeak(tts) {
  const EspeakTTS = require("./EspeakTTS");
  return new EspeakTTS({ voice: tts.espeakVoice, speed: tts.espeakSpeed });
}

function hasUrl(url) {
  return Array.isArray(url) ? url.some((u) => (typeof u === "string" ? u : u?.url)) : Boolean(url);
}

/**
 * @param {object} tts The module's `tts` config section.
 */
function createTTS(tts) {
  const ChainTTS = require("./ChainTTS");
  switch (tts.provider ?? "auto") {
    case "auto": {
      // The most natural voice that is running: Kokoro (a Mac/PC, or this
      // machine), then Piper, then espeak-ng so the mirror is never mute.
      const engines = [kokoro(tts, hasUrl(tts.kokoroUrl) ? tts.kokoroUrl : LOCAL_KOKORO)];
      if (hasUrl(tts.piperUrl) || tts.piperModel) engines.push(piper(tts));
      engines.push(espeak(tts));
      return new ChainTTS(engines);
    }
    case "kokoro": {
      // Kokoro (natural, needs a Mac or PC) with Piper as the fallback voice.
      const engines = [kokoro(tts, tts.kokoroUrl)];
      if (hasUrl(tts.piperUrl) || tts.piperModel) engines.push(piper(tts));
      return new ChainTTS(engines);
    }
    case "piper":
      return piper(tts);
    case "espeak":
      return espeak(tts);
    default:
      throw new Error(`Unknown tts.provider "${tts.provider}". Use "auto", "kokoro", "piper" or "espeak".`);
  }
}

module.exports = { createTTS, LOCAL_KOKORO };
