"use strict";

/**
 * Text-to-speech factory.
 * Every engine exposes: name, synthesize(text) → Promise<Buffer wav>, healthCheck() → Promise<string|null>.
 */

/**
 * @param {object} tts The module's `tts` config section.
 */
function createTTS(tts) {
  switch (tts.provider) {
    case "piper": {
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
    case "espeak": {
      const EspeakTTS = require("./EspeakTTS");
      return new EspeakTTS({ voice: tts.espeakVoice, speed: tts.espeakSpeed });
    }
    default:
      throw new Error(`Unknown tts.provider "${tts.provider}". Use "piper" or "espeak".`);
  }
}

module.exports = { createTTS };
