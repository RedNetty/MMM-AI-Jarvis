"use strict";

/**
 * Phrasing helpers so replies sound like a person and not a data feed:
 * relative times ("tonight at 7", "in 25 minutes", "tomorrow morning"),
 * natural durations ("an hour and a half") and a little variety so the same
 * question doesn't always get the identical sentence.
 *
 * Output is written text ("7:30 PM"); verbalize() turns it into words for
 * the voice, so the mirror and the speaker both get the form that suits them.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SMALL = ["no", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * Pick one phrasing at random (injectable for tests via Talk.random).
 * @template T
 * @param {T[]} options
 * @returns {T}
 */
function pick(options) {
  return options[Math.floor(Talk.random() * options.length) % options.length];
}

/** Local midnight of a date. */
function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Whole calendar days from `now` to `date` (0 = same day, 1 = tomorrow, -1 = yesterday). */
function calendarDays(date, now = new Date()) {
  return Math.round((startOfDay(date) - startOfDay(now)) / DAY);
}

/** "morning" | "afternoon" | "evening" | "night" for an hour 0-23. */
function partOfDay(hour) {
  if (hour >= 5 && hour < 12) return "morning";
  if (hour >= 12 && hour < 17) return "afternoon";
  if (hour >= 17 && hour < 21) return "evening";
  return "night";
}

/**
 * Written clock time: "7 PM", "7:30 PM", "noon", "midnight".
 * @param {Date} date
 * @param {{ meridiem?: boolean, hour12?: boolean }} [options] hour12 false gives "19:30".
 */
function clock(date, { meridiem = true, hour12 = true } = {}) {
  const h = date.getHours();
  const m = date.getMinutes();
  if (!hour12) return `${h}:${String(m).padStart(2, "0")}`;
  if (h === 0 && m === 0) return "midnight";
  if (h === 12 && m === 0) return "noon";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  const time = m === 0 ? String(h12) : `${h12}:${String(m).padStart(2, "0")}`;
  return meridiem ? `${time} ${h < 12 ? "AM" : "PM"}` : time;
}

/** True for locales that write 24-hour time (most of Europe). */
function uses24h(locale) {
  try {
    return !new Intl.DateTimeFormat(locale || undefined, { hour: "numeric" }).resolvedOptions().hour12;
  } catch {
    return false;
  }
}

function weekday(date, locale) {
  return date.toLocaleDateString(locale || "en", { weekday: "long" });
}

function monthDay(date, locale) {
  const month = date.toLocaleDateString(locale || "en", { month: "long" });
  return `${month} ${ordinal(date.getDate())}`;
}

function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] ?? "th"}`;
}

/**
 * The day relative to now: "today", "tonight", "this afternoon",
 * "tomorrow night", "on Saturday", "next Tuesday", "on November 3rd".
 * @param {Date} date
 * @param {{ now?: Date, locale?: string, withPart?: boolean }} [options]
 *   withPart: name the part of the day ("tonight", "tomorrow morning").
 */
function relativeDay(date, { now = new Date(), locale, withPart = true } = {}) {
  const days = calendarDays(date, now);
  const part = partOfDay(date.getHours());
  if (days === 0) {
    if (!withPart) return "today";
    if (part === "night" || part === "evening") return date.getHours() < 5 ? "early this morning" : "tonight";
    return `this ${part}`;
  }
  if (days === 1) {
    if (!withPart) return "tomorrow";
    if (date.getHours() < 5) return "late tonight";
    return `tomorrow ${part === "evening" ? "evening" : part}`;
  }
  if (days === -1) return withPart ? `yesterday ${part === "night" ? "evening" : part}` : "yesterday";
  if (days > 1 && days < 7) return `on ${weekday(date, locale)}`;
  if (days >= 7 && days < 14) return `next ${weekday(date, locale)}`;
  if (days < -1 && days > -7) return `last ${weekday(date, locale)}`;
  return `on ${monthDay(date, locale)}`;
}

/**
 * When something happens, the way you'd say it: "in 25 minutes",
 * "tonight at 7", "tomorrow at 1:30 PM", "Saturday at 3 PM", "on November 3rd at 8 PM".
 * @param {Date|string|number} when
 * @param {{ now?: Date, locale?: string }} [options]
 */
function when(when, { now = new Date(), locale } = {}) {
  const date = new Date(when);
  if (!Number.isFinite(date.getTime())) return "";
  const diff = date - now;
  if (diff > -MINUTE && diff < MINUTE) return "right now";
  if (diff > 0 && diff < 55 * MINUTE) return `in ${duration(diff)}`;
  if (diff < 0 && diff > -55 * MINUTE) return `${duration(-diff)} ago`;

  const h24 = uses24h(locale);
  const time = clock(date, { hour12: !h24 });
  const days = calendarDays(date, now);
  const part = partOfDay(date.getHours());
  if (days === 0) {
    if (part === "evening" || part === "night") return `tonight at ${h24 ? time : clock(date, { meridiem: date.getHours() < 18 })}`;
    return `today at ${time}`;
  }
  if (days === 1 && date.getHours() < 5) return `late tonight at ${time}`;
  if (days === 1) return `tomorrow at ${time}`;
  if (days === -1) return `yesterday at ${time}`;
  if (days > 1 && days < 7) return `${weekday(date, locale)} at ${time}`;
  return `on ${monthDay(date, locale)} at ${time}`;
}

/**
 * A duration in words: "25 minutes", "an hour and a half", "2 hours and 10 minutes",
 * "about 3 days", "45 seconds".
 * @param {number} ms
 */
function duration(ms) {
  const totalMin = Math.round(Math.abs(ms) / MINUTE);
  if (Math.abs(ms) < MINUTE) {
    const s = Math.max(1, Math.round(Math.abs(ms) / 1000));
    return `${s} second${s === 1 ? "" : "s"}`;
  }
  if (totalMin < 60) return totalMin === 1 ? "a minute" : `${totalMin} minutes`;
  const hours = Math.floor(totalMin / 60);
  const min = totalMin % 60;
  if (hours < 24) {
    const h = hours === 1 ? "an hour" : `${hours} hours`;
    if (min === 0) return h;
    if (min === 30) return hours === 1 ? "an hour and a half" : `${hours} and a half hours`;
    if (min === 15 && hours === 1) return "an hour and a quarter";
    return `${h} and ${min === 1 ? "a minute" : `${min} minutes`}`;
  }
  const days = Math.round(totalMin / 1440);
  if (days < 14) return days === 1 ? "a day" : `${days} days`;
  const weeks = Math.round(days / 7);
  return days % 7 === 0 ? `${weeks} weeks` : `about ${weeks} weeks`;
}

/**
 * The current time the way people say it when asked: "It's 6:46." In the
 * last minutes before the hour or exactly on it, the friendlier forms
 * ("It's just about 7.", "It's 7 o'clock.").
 * @param {Date} [now]
 * @param {{ locale?: string }} [options]
 */
function timeNow(now = new Date(), { locale } = {}) {
  const m = now.getMinutes();
  if (uses24h(locale)) return `It's ${clock(now, { hour12: false })}.`;
  const next = new Date(now.getTime() + HOUR);
  if (m === 0) return `It's ${clock(now, { meridiem: false })} o'clock.`.replace(/(noon|midnight) o'clock/, "$1");
  if (m >= 58) return `It's just about ${clock(new Date(next.setMinutes(0)), { meridiem: false })}.`;
  return `It's ${clock(now, { meridiem: false })}.`;
}

/** "Wednesday, October 21st". */
function dateLong(date, { locale } = {}) {
  return `${weekday(date, locale)}, ${monthDay(date, locale)}`;
}

/** 0 → "no", 3 → "three", 14 → "14". */
function count(n) {
  return n >= 0 && n <= 10 ? SMALL[n] : String(n);
}

/** ["a", "b", "c"] → "a, b and c". */
function list(items) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs[0] ?? "";
  return `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`;
}

const Talk = {
  random: Math.random,
  pick,
  partOfDay,
  calendarDays,
  startOfDay,
  clock,
  uses24h,
  relativeDay,
  when,
  duration,
  timeNow,
  dateLong,
  monthDay,
  weekday,
  ordinal,
  count,
  list,
};

module.exports = Talk;
