"use strict";

/**
 * Text-to-speech factory.
 * Every engine exposes: name, synthesize(text) → Promise<Buffer wav>, healthCheck() → Promise<string|null>,
 * and optionally start(), stop() and `available`.
 */

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

/**
 * @param {object} tts The module's `tts` config section.
 */
function createTTS(tts) {
  switch (tts.provider) {
    case "kokoro": {
      // Kokoro (natural, needs a Mac or PC) with Piper as the fallback voice.
      const KokoroTTS = require("./KokoroTTS");
      const ChainTTS = require("./ChainTTS");
      const engines = [new KokoroTTS({ url: tts.kokoroUrl, voice: tts.kokoroVoice, speed: tts.kokoroSpeed })];
      if (tts.piperUrl || tts.piperModel) engines.push(piper(tts));
      return new ChainTTS(engines);
    }
    case "piper":
      return piper(tts);
    case "espeak": {
      const EspeakTTS = require("./EspeakTTS");
      return new EspeakTTS({ voice: tts.espeakVoice, speed: tts.espeakSpeed });
    }
    default:
      throw new Error(`Unknown tts.provider "${tts.provider}". Use "kokoro", "piper" or "espeak".`);
  }
}

module.exports = { createTTS };
