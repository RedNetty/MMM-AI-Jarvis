"use strict";

/**
 * Text helpers shared by the speech and display pipelines.
 */

/**
 * Strip markdown, URLs and emoji so the text reads naturally when spoken and
 * displays cleanly on the mirror. Non-ASCII letters (é, ü, ß, etc.) are kept.
 * @param {string} text
 * @returns {string}
 */
function cleanForSpeech(text) {
  if (!text) return "";
  return String(text)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+•]|\d+[.)])\s+/gm, "")
    .replace(/(\*\*|__|\*|_|~~)(?=\S)([^*_~]+?)(?<=\S)\1/g, "$2")
    .replace(/[*#_~>|]/g, "")
    .replace(/\p{Extended_Pictographic}|\u{FE0F}|\u{200D}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Split text into speakable chunks of whole sentences, each at most maxChars
 * long where possible. Used to start speaking the first sentence while later
 * ones are still being synthesised.
 * @param {string} text
 * @param {number} [maxChars=220]
 * @param {boolean} [firstAlone=false] Keep the first sentence as its own chunk
 *        so speech can start as soon as possible.
 * @returns {string[]}
 */
function splitSentences(text, maxChars = 220, firstAlone = false) {
  const sentences = String(text)
    .match(/[^.!?]+(?:[.!?]+["')\]]*|$)/g)
    ?.map((s) => s.trim())
    .filter(Boolean) ?? [];

  const chunks = [];
  let current = "";
  for (const sentence of sentences) {
    const startNew = firstAlone && chunks.length === 0 && current !== "";
    if (startNew || (current && current.length + sentence.length + 1 > maxChars)) {
      chunks.push(current);
      current = sentence;
    } else {
      current = current ? `${current} ${sentence}` : sentence;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Collects streamed model output and hands back complete sentences as soon
 * as they are finished, so speech can start before the whole answer exists.
 * Very short fragments ("Sure.") are merged with the next sentence so the
 * voice doesn't sound choppy.
 */
class SentenceStreamer {
  /**
   * @param {number} [minChars=24] Shortest sentence emitted on its own.
   */
  constructor(minChars = 24) {
    this.minChars = minChars;
    this.buffer = "";
  }

  /**
   * @param {string} delta Newly generated text.
   * @returns {string[]} Sentences completed by this delta.
   */
  push(delta) {
    this.buffer += delta;
    const out = [];
    // A sentence ends at . ! ? (plus closing quotes) followed by whitespace.
    // Decimals ("3.5") and abbreviations without a following space don't match.
    const re = /[.!?]+["')\]]*\s+/g;
    let start = 0;
    let match;
    while ((match = re.exec(this.buffer))) {
      const end = match.index + match[0].length;
      const sentence = this.buffer.slice(start, end).trim();
      if (sentence.length >= this.minChars) {
        out.push(sentence);
        start = end;
      }
    }
    this.buffer = this.buffer.slice(start);
    return out;
  }

  /** @returns {string} Whatever is left once generation has finished. */
  flush() {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest;
  }
}

/**
 * Normalise text for loose matching: lowercase, no punctuation, single spaces.
 * @param {string} text
 * @returns {string}
 */
function normalize(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}' ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Format a Date as YYYY-MM-DD in local time.
 * @param {Date} [date=new Date()]
 * @returns {string}
 */
function isoDate(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Whole days between two YYYY-MM-DD dates (b - a).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function daysBetween(a, b) {
  const ms = Date.parse(`${b}T00:00:00`) - Date.parse(`${a}T00:00:00`);
  return Math.round(ms / 86400000);
}

const NUMBER_WORDS = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18,
  nineteen: 19, twenty: 20, thirty: 30, forty: 40, "forty five": 45, fifty: 50, sixty: 60, ninety: 90,
};
const UNIT_SECONDS = { h: 3600, hr: 3600, hrs: 3600, hour: 3600, hours: 3600, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, s: 1, sec: 1, secs: 1, second: 1, seconds: 1 };

/**
 * Parse a spoken duration ("10 minutes", "an hour and a half", "1h 30m",
 * "half an hour", "twenty five seconds") into seconds.
 * @param {string} text
 * @returns {number|null}
 */
function parseDuration(text) {
  let t = normalize(text).replace(/-/g, " ");
  let total = 0;

  if (/\bhalf an? hour\b/.test(t)) {
    total += 1800;
    t = t.replace(/\bhalf an? hour\b/, " ");
  }
  // "twenty five" → 25
  t = t.replace(/\b(twenty|thirty|forty|fifty)\s+(one|two|three|four|five|six|seven|eight|nine)\b/g, (_, tens, ones) => String(NUMBER_WORDS[tens] + NUMBER_WORDS[ones]));
  t = t.replace(/\b(forty five|[a-z]+)\b/g, (w) => (NUMBER_WORDS[w] !== undefined && w !== "a" && w !== "an" ? String(NUMBER_WORDS[w]) : w));
  t = t.replace(/\b(\d+)(h|hr|hrs|m|min|mins|s|sec|secs)\b/g, "$1 $2");

  const re = /\b(\d+(?:\.\d+)?|an?)\s+(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b(\s+and\s+a\s+half)?/g;
  let match;
  while ((match = re.exec(t))) {
    const n = match[1] === "a" || match[1] === "an" ? 1 : Number(match[1]);
    const unit = UNIT_SECONDS[match[2]];
    total += n * unit + (match[3] ? unit / 2 : 0);
  }
  return total > 0 ? Math.round(total) : null;
}

/**
 * Speak a duration naturally: 90 → "1 minute 30 seconds".
 * @param {number} seconds
 */
function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.round(seconds % 60);
  const part = (n, unit) => (n ? `${n} ${unit}${n === 1 ? "" : "s"}` : "");
  return [part(h, "hour"), part(m, "minute"), part(s, "second")].filter(Boolean).join(" ") || "0 seconds";
}

module.exports = { cleanForSpeech, splitSentences, SentenceStreamer, normalize, isoDate, daysBetween, parseDuration, formatDuration };
