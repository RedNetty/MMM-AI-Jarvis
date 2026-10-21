"use strict";

/**
 * Rewrite text so a text-to-speech voice reads it the way a person would say
 * it. Only the audio uses this: the mirror keeps showing the written form
 * ("7:30 PM", "58°F") because that reads better on screen.
 *
 * Piper (and most small TTS voices) read "6:46" as "six hundred forty-six",
 * "7:00 PM" as "seven zero zero P D M", "67'" as nothing at all and
 * "Wed, Oct 21" letter by letter. Every rule here comes from round-trip
 * tests (speak with Piper, transcribe with Whisper, compare).
 */

const ONES = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const ORDINAL_WORDS = { one: "first", two: "second", three: "third", five: "fifth", eight: "eighth", nine: "ninth", twelve: "twelfth" };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 };
const WEEKDAY_ABBR = { mon: "Monday", tue: "Tuesday", tues: "Tuesday", wed: "Wednesday", thu: "Thursday", thur: "Thursday", thurs: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };

const SPORT_PERIODS = {
  Q: (n) => `${ordinalWord(n)} quarter`,
  P: (n) => `${ordinalWord(n)} period`,
  H: (n) => `${ordinalWord(n)} half`,
};

/**
 * Number 0-999 as words: 46 → "forty-six".
 * @param {number} n
 */
function numberWords(n) {
  n = Math.trunc(Math.abs(n));
  if (n < 20) return ONES[n];
  if (n < 100) return TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : "");
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred${n % 100 ? ` ${numberWords(n % 100)}` : ""}`;
  return String(n);
}

/** 4 → "fourth", 21 → "twenty-first". */
function ordinalWord(n) {
  const words = numberWords(n);
  const last = words.split(/[- ]/).pop();
  const ord = ORDINAL_WORDS[last] ?? (last.endsWith("y") ? `${last.slice(0, -1)}ieth` : `${last}th`);
  return words.slice(0, words.length - last.length) + ord;
}

/** 21 → "21st" (digits read naturally by every voice tested). */
function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/**
 * A clock time as words: (18, 46) → "six forty-six p.m.", (7, 0) → "seven p.m.",
 * (9, 5) → "nine oh five a.m.". With `meridiem` false the a.m./p.m. is left off.
 * @param {number} hours 0-23
 * @param {number} minutes 0-59
 * @param {{ meridiem?: boolean }} [options]
 */
function clockWords(hours, minutes, { meridiem = true } = {}) {
  if (hours === 0 && minutes === 0) return "midnight";
  if (hours === 12 && minutes === 0) return "noon";
  const h12 = hours % 12 === 0 ? 12 : hours % 12;
  let words = numberWords(h12);
  if (minutes === 0) words += meridiem ? "" : " o'clock";
  else if (minutes < 10) words += ` oh ${numberWords(minutes)}`;
  else words += ` ${numberWords(minutes)}`;
  return meridiem ? `${words} ${hours < 12 ? "a.m." : "p.m."}` : words;
}

/** Game clock "2:31" → "two thirty-one", "0:45" → "forty-five seconds", "12:00" → "twelve minutes". */
function gameClockWords(minutes, seconds) {
  if (minutes === 0) return `${numberWords(seconds)} second${seconds === 1 ? "" : "s"}`;
  if (seconds === 0) return `${numberWords(minutes)} minute${minutes === 1 ? "" : "s"}`;
  return `${numberWords(minutes)} ${seconds < 10 ? `oh ${numberWords(seconds)}` : numberWords(seconds)}`;
}

function usesMonthFirst(locale) {
  return !locale || /^en(-US|-CA|-PH)?$/i.test(locale) || /^en$/i.test(locale);
}

/**
 * @param {string} text Text exactly as shown on the mirror.
 * @param {{ locale?: string }} [options] Locale decides whether "3/4" is March 4th or April 3rd.
 * @returns {string} Text to hand to the TTS voice.
 */
function verbalize(text, { locale } = {}) {
  let t = String(text ?? "");
  if (!t) return t;

  // ── Sports clocks (before generic times, which they look like) ──────────
  // "Q4 2:31" / "2:31 Q4" / "2:31 - 4th" → "two thirty-one left in the fourth quarter"
  t = t.replace(/\b([QPH])([1-4])\s+(\d{1,2}):(\d{2})\b/g, (_, p, n, m, s) => `${gameClockWords(+m, +s)} left in the ${SPORT_PERIODS[p](+n)}`);
  t = t.replace(/\b(\d{1,2}):(\d{2})\s+([QPH])([1-4])\b/g, (_, m, s, p, n) => `${gameClockWords(+m, +s)} left in the ${SPORT_PERIODS[p](+n)}`);
  t = t.replace(/\b(\d{1,2}):(\d{2})\s*-\s*(\d)(?:st|nd|rd|th)\b/g, (_, m, s, n) => `${gameClockWords(+m, +s)} left in the ${ordinalWord(+n)}`);
  t = t.replace(/\b([QPH])([1-4])\b/g, (_, p, n) => `the ${SPORT_PERIODS[p](+n)}`);
  t = t.replace(/\b(Top|Bot|Bottom|Mid|Middle|End)\s+(\d{1,2})(?:st|nd|rd|th)\b/g, (_, w, n) => {
    const part = { Top: "top", Bot: "bottom", Bottom: "bottom", Mid: "middle", Middle: "middle", End: "end" }[w];
    return `${part} of the ${ordinalWord(+n)}`;
  });
  // Soccer minutes: "45'+2'" → "the forty-fifth minute plus two", "67'" → "the 67th minute"
  t = t.replace(/\b(\d{1,3})'\s*\+\s*(\d{1,2})'?/g, (_, m, x) => `${ordinalSuffix(+m)} minute plus ${numberWords(+x)}`);
  t = t.replace(/\b(\d{1,3})'(?![\p{L}\d])/gu, (_, m) => `${ordinalSuffix(+m)} minute`);
  t = t.replace(/\bHT\b/g, "half time").replace(/\bFT\b/g, "full time").replace(/\bOT\b/g, "overtime");

  // ── Clock times ────────────────────────────────────────────────────────
  // "7:00 PM" → "seven p.m.", "6:46" → "six forty-six", "18:30" → "six thirty p.m."
  t = t.replace(/\b(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap])\.?\s?m\b\.?/gi, (_, h, m, ap) => {
    const hours = (+h % 12) + (ap.toLowerCase() === "p" ? 12 : 0);
    return clockWords(hours, +m);
  });
  t = t.replace(/\b(\d{1,2})\s*([ap])\.?\s?m\b\.?/gi, (_, h, ap) => clockWords((+h % 12) + (ap.toLowerCase() === "p" ? 12 : 0), 0));
  t = t.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!:)/g, (_, h, m) => (+h > 12 || +h === 0 ? clockWords(+h, +m) : clockWords(+h, +m, { meridiem: false })));

  // ── Dates ──────────────────────────────────────────────────────────────
  // ISO "2026-10-24" → "October 24th, 2026"
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (all, y, m, d) => (+m >= 1 && +m <= 12 ? `${MONTHS[+m - 1]} ${ordinalSuffix(+d)}, ${y}` : all));
  // "10/24" or "10/24/2026" (day/month outside the US)
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g, (all, a, b, y) => {
    const [month, day] = usesMonthFirst(locale) ? [+a, +b] : [+b, +a];
    if (month < 1 || month > 12 || day < 1 || day > 31) return all;
    return `${MONTHS[month - 1]} ${ordinalSuffix(day)}${y ? `, ${y.length === 2 ? `20${y}` : y}` : ""}`;
  });
  // "Oct 21" / "Oct. 21st" → "October 21st"; "21 Oct" → "the 21st of October"
  t = t.replace(/\b(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b/gi, (_, mon, d) => `${MONTHS[MONTH_ABBR[mon.toLowerCase()]]} ${ordinalSuffix(+d)}`);
  t = t.replace(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept?|Oct|Nov|Dec)\b\.?/gi, (_, d, mon) => `the ${ordinalSuffix(+d)} of ${MONTHS[MONTH_ABBR[mon.toLowerCase()]]}`);
  t = t.replace(/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?!\d|:|st|nd|rd|th)\b/g, (_, mon, d) => `${mon} ${ordinalSuffix(+d)}`);
  // "Wed, " / "Sat." before a date or comma; never the words "sun" or "sat" in a sentence.
  t = t.replace(/\b(Mon|Tue|Tues|Wed|Thu|Thur|Thurs|Fri|Sat|Sun)\b\.?(?=,|\s+(?:January|February|March|April|May|June|July|August|September|October|November|December|the\s+\d|\d))/g, (_, d) => WEEKDAY_ABBR[d.toLowerCase()]);

  // ── Units ──────────────────────────────────────────────────────────────
  t = t.replace(/(^|[^\d.])-(\d+(?:\.\d+)?)\s*°/g, "$1minus $2°");
  t = t.replace(/(\d+(?:\.\d+)?)\s*°(?:\s?[CF]\b)?/g, (_, n) => `${n} ${+n === 1 ? "degree" : "degrees"}`);
  t = t.replace(/°/g, " degrees");
  t = t.replace(/(\d+(?:\.\d+)?)\s*%/g, "$1 percent");
  t = t.replace(/(\d)\s*km\/h\b/gi, "$1 kilometers per hour");
  t = t.replace(/(\d)\s*mph\b/gi, "$1 miles per hour");
  t = t.replace(/(\d)\s*m\/s\b/gi, "$1 meters per second");
  t = t.replace(/(\d)\s*km\b/g, "$1 kilometers");
  t = t.replace(/(\d)\s*mm\b/g, "$1 millimeters");
  t = t.replace(/(\d)\s*cm\b/g, "$1 centimeters");
  t = t.replace(/(\d)\s*(?:hrs?|h)\s*(\d+)\s*(?:mins?|m)\b/g, (_, h, m) => `${h} ${+h === 1 ? "hour" : "hours"} ${m} minutes`);
  t = t.replace(/(\d)\s*mins?\b/g, "$1 minutes");
  t = t.replace(/(\d)\s*secs?\b/g, "$1 seconds");

  // ── Numbers, ranges, symbols ───────────────────────────────────────────
  t = t.replace(/\b(\d+)\s*[-–—]\s*(\d+)\b/g, "$1 to $2");
  t = t.replace(/\b(\d+)\s*x\s*(\d+)\b/g, "$1 by $2");
  t = t.replace(/\$(\d+)\.(\d{2})\b/g, (_, d, c) => (+c ? `${d} dollars ${+c} cents` : `${d} dollars`));
  t = t.replace(/\$(\d+)\b/g, (_, d) => `${d} ${+d === 1 ? "dollar" : "dollars"}`);
  t = t.replace(/\s+vs?\.?\s+/gi, " versus ");
  t = t.replace(/\s*&\s*/g, " and ");
  t = t.replace(/\bw\//gi, "with ");
  t = t.replace(/\be\.g\.,?/gi, "for example").replace(/\bi\.e\.,?/gi, "that is").replace(/\betc\./gi, "and so on");
  t = t.replace(/\s*[·•|]\s*/g, ", ");
  t = t.replace(/\band\/or\b/gi, "or");

  return t
    .replace(/\b([ap])\.m\.\./g, "$1.m.")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

module.exports = { verbalize, numberWords, ordinalWord, ordinalSuffix, clockWords };
