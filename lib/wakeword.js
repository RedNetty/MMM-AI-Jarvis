"use strict";

const { normalize } = require("./text");

/**
 * Wake word and voice command parsing.
 *
 * Wake word detection is done on the transcript rather than on raw audio. That
 * keeps it engine-agnostic (any speech-to-text that returns text works), and
 * because utterances are only transcribed after the voice activity detector
 * hears speech, it stays cheap.
 */

const FILLERS = "(?:(?:hey|hi|hello|ok|okay|yo)[\\s,]+)?";
const BOUNDARY_BEFORE = "(?:^|[^\\p{L}\\p{N}])";
const BOUNDARY_AFTER = "(?=$|[^\\p{L}\\p{N}])";
const TRIM_LEADING = /^[\s,.!?:;\-–—]+/;
const TRIM_TRAILING = /[\s,.!?:;\-–—]+$/;

const STOP_PATTERNS = [
  "stop",
  "stop it",
  "stop talking",
  "cancel",
  "quiet",
  "be quiet",
  "shut up",
  "never mind",
  "nevermind",
  "forget it",
  "enough",
  "that's enough",
  "that is enough",
  "that's all",
  "that is all",
  "thanks that's all",
  "thank you that's all",
];

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Build a matcher for the wake word and its aliases.
 * @param {string} wakeWord
 * @param {string[]} [aliases]
 */
function createWakeWordMatcher(wakeWord, aliases = []) {
  const words = [wakeWord, ...aliases]
    .map((w) => String(w ?? "").trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .map((w) => escapeRegExp(w).replace(/\s+/g, "[\\s,]+"));

  if (words.length === 0) throw new Error("A wake word is required.");

  const regex = new RegExp(
    `${BOUNDARY_BEFORE}${FILLERS}(?:${words.join("|")})${BOUNDARY_AFTER}`,
    "iu",
  );

  return {
    /**
     * @param {string} transcript
     * @returns {{ heard: boolean, query: string }}
     */
    parse(transcript) {
      const text = String(transcript ?? "").trim();
      const match = regex.exec(text);
      if (!match) return { heard: false, query: text };

      const start = match.index;
      const end = start + match[0].length;
      const after = text.slice(end).replace(TRIM_LEADING, "").trim();
      const before = text.slice(0, start).replace(TRIM_TRAILING, "").trim();

      // "Iris, what's the weather" → after; "what's the weather, Iris" → before.
      const query = after || before;
      return { heard: true, query };
    },

    /**
     * Remove the wake word (if present) and return what remains.
     * @param {string} transcript
     */
    strip(transcript) {
      const { heard, query } = this.parse(transcript);
      return heard ? query : String(transcript ?? "").trim();
    },
  };
}

/**
 * True when the utterance is a short "stop"/"cancel" style command.
 * Long sentences that merely contain "stop" ("don't stop me now") are ignored.
 * @param {string} text Transcript with the wake word already removed.
 */
function isStopCommand(text) {
  const n = normalize(text).replace(/\b(please|now|iris|jarvis)\b/g, "").replace(/\s+/g, " ").trim();
  if (!n || n.split(" ").length > 4) return false;
  return STOP_PATTERNS.includes(n);
}

module.exports = { createWakeWordMatcher, isStopCommand };
