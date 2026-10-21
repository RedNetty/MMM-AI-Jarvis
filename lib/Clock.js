"use strict";

const Talk = require("./speech/talk");
const { normalize } = require("./text");

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept?|oct|nov|dec)";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12,
  fifteen: 15, twenty: 20, thirty: 30, forty: 40, "forty five": 45, fifty: 50,
};

/**
 * Places people ask about that aren't IANA zone names themselves. Every
 * city that is ("tokyo", "london", "new york") is found automatically from
 * Intl.supportedValuesOf("timeZone").
 */
const PLACES = {
  // US & Canada
  "san francisco": "America/Los_Angeles", "seattle": "America/Los_Angeles", "portland": "America/Los_Angeles",
  "san diego": "America/Los_Angeles", "las vegas": "America/Los_Angeles", "california": "America/Los_Angeles",
  "pacific time": "America/Los_Angeles", "west coast": "America/Los_Angeles", "washington state": "America/Los_Angeles",
  "dallas": "America/Chicago", "houston": "America/Chicago", "austin": "America/Chicago", "texas": "America/Chicago",
  "minneapolis": "America/Chicago", "nashville": "America/Chicago", "new orleans": "America/Chicago", "central time": "America/Chicago",
  "denver": "America/Denver", "salt lake city": "America/Denver", "colorado": "America/Denver", "mountain time": "America/Denver",
  "phoenix": "America/Phoenix", "arizona": "America/Phoenix",
  "boston": "America/New_York", "miami": "America/New_York", "atlanta": "America/New_York", "washington": "America/New_York",
  "washington dc": "America/New_York", "philadelphia": "America/New_York", "florida": "America/New_York", "east coast": "America/New_York",
  "eastern time": "America/New_York", "new york city": "America/New_York", "nyc": "America/New_York",
  "hawaii": "Pacific/Honolulu", "alaska": "America/Anchorage", "montreal": "America/Toronto", "ottawa": "America/Toronto",
  "calgary": "America/Edmonton", "canada": "America/Toronto",
  // Europe
  "england": "Europe/London", "uk": "Europe/London", "united kingdom": "Europe/London", "britain": "Europe/London",
  "manchester": "Europe/London", "liverpool": "Europe/London", "edinburgh": "Europe/London", "scotland": "Europe/London",
  "ireland": "Europe/Dublin", "france": "Europe/Paris", "germany": "Europe/Berlin", "munich": "Europe/Berlin",
  "frankfurt": "Europe/Berlin", "hamburg": "Europe/Berlin", "spain": "Europe/Madrid", "barcelona": "Europe/Madrid",
  "italy": "Europe/Rome", "milan": "Europe/Rome", "florence": "Europe/Rome", "venice": "Europe/Rome",
  "portugal": "Europe/Lisbon", "netherlands": "Europe/Amsterdam", "holland": "Europe/Amsterdam",
  "belgium": "Europe/Brussels", "switzerland": "Europe/Zurich", "geneva": "Europe/Zurich", "austria": "Europe/Vienna",
  "greece": "Europe/Athens", "sweden": "Europe/Stockholm", "norway": "Europe/Oslo", "denmark": "Europe/Copenhagen",
  "finland": "Europe/Helsinki", "poland": "Europe/Warsaw", "czech republic": "Europe/Prague", "hungary": "Europe/Budapest",
  "iceland": "Atlantic/Reykjavik", "russia": "Europe/Moscow", "ukraine": "Europe/Kyiv", "kiev": "Europe/Kyiv", "turkey": "Europe/Istanbul",
  // Asia & Oceania
  "japan": "Asia/Tokyo", "osaka": "Asia/Tokyo", "kyoto": "Asia/Tokyo", "china": "Asia/Shanghai", "beijing": "Asia/Shanghai",
  "korea": "Asia/Seoul", "south korea": "Asia/Seoul", "india": "Asia/Kolkata", "mumbai": "Asia/Kolkata", "delhi": "Asia/Kolkata",
  "new delhi": "Asia/Kolkata", "bangalore": "Asia/Kolkata", "pakistan": "Asia/Karachi", "bangladesh": "Asia/Dhaka",
  "thailand": "Asia/Bangkok", "vietnam": "Asia/Ho_Chi_Minh", "philippines": "Asia/Manila", "indonesia": "Asia/Jakarta",
  "bali": "Asia/Makassar", "malaysia": "Asia/Kuala_Lumpur", "taiwan": "Asia/Taipei", "uae": "Asia/Dubai", "abu dhabi": "Asia/Dubai",
  "saudi arabia": "Asia/Riyadh", "israel": "Asia/Jerusalem", "tel aviv": "Asia/Jerusalem", "qatar": "Asia/Qatar",
  "australia": "Australia/Sydney", "new zealand": "Pacific/Auckland", "wellington": "Pacific/Auckland",
  // Americas & Africa
  "mexico": "America/Mexico_City", "brazil": "America/Sao_Paulo", "rio": "America/Sao_Paulo", "rio de janeiro": "America/Sao_Paulo",
  "argentina": "America/Argentina/Buenos_Aires", "buenos aires": "America/Argentina/Buenos_Aires", "chile": "America/Santiago",
  "colombia": "America/Bogota", "peru": "America/Lima", "egypt": "Africa/Cairo", "south africa": "Africa/Johannesburg",
  "cape town": "Africa/Johannesburg", "nigeria": "Africa/Lagos", "kenya": "Africa/Nairobi", "morocco": "Africa/Casablanca",
  "utc": "UTC", "gmt": "UTC",
};

let zoneIndex = null;
/** IANA zones by their city name ("new york" → "America/New_York"). */
function zonesByCity() {
  if (zoneIndex) return zoneIndex;
  zoneIndex = new Map();
  let zones = [];
  try {
    zones = Intl.supportedValuesOf("timeZone");
  } catch {
    zones = [];
  }
  for (const zone of zones) {
    const city = zone.split("/").pop().replace(/_/g, " ").toLowerCase();
    if (!zoneIndex.has(city)) zoneIndex.set(city, zone);
  }
  return zoneIndex;
}

/**
 * Time and date reasoning without a language model: "what time is it",
 * "what time is it in Tokyo", "how long until Christmas", "what day is
 * Halloween", "how many days until Friday", "what's the date next Tuesday".
 *
 * Small local models get dates and time zones wrong all the time; this is
 * exact, instant, and its answers are written to be spoken.
 */
class Clock {
  /**
   * @param {{ locale?: string, facts?: () => string[] }} [options]
   *   facts: remembered facts, used for "my birthday" / "Sam's birthday".
   */
  constructor({ locale, facts = () => [] } = {}) {
    this.locale = locale;
    this.facts = facts;
    this.lastCard = null;
  }

  /**
   * Answer a time or date question.
   * @param {string} question
   * @param {Date} [now]
   * @returns {string|null} The spoken answer, or null if it isn't one.
   */
  /**
   * Like answer(), plus what to show on the mirror: an analog clock for
   * another city, or a countdown.
   * @param {string} question
   * @param {Date} [now]
   * @returns {{ spoken: string, card: object|null } | null}
   */
  respond(question, now = new Date()) {
    const spoken = this.answer(question, now);
    return spoken ? { spoken, card: this.lastCard } : null;
  }

  answer(question, now = new Date()) {
    this.lastCard = null;
    const q = plain(question).replace(/\bwhats\b/g, "what is");
    const opts = { now, locale: this.locale };

    // ── Time somewhere else ──
    const elsewhere = /\btime (?:is it |it is )?(?:right now |now )?(?:in|over in) (.+?)(?: right now| now)?$/.exec(q);
    if (elsewhere && !/\b(?:days?|weeks?|minutes?|hours?)\b/.test(elsewhere[1])) return this._timeIn(elsewhere[1], now);

    // ── Countdowns: "how long until …", "how many days until …" ──
    const until = /\bhow (?:long|many (?:days|weeks|hours|minutes|sleeps)|much (?:longer|time)) (?:is it |is there |do i have |have i got |left )?(?:until|till|til|to|before|left (?:until|till|before))\s+(.+)$/.exec(q);
    if (until) {
      const target = this.parse(until[1], now);
      return target ? this._until(target, now) : null;
    }

    // ── "when is Christmas" (dates only; "when is the game" is not ours) ──
    const whenIs = /^when (?:is|s|does|will be) (.+?)(?: this year| next year)?$/.exec(q);
    if (whenIs) {
      const target = this.parse(whenIs[1], now);
      return target && target.named ? this._until(target, now) : null;
    }

    // ── "what day is Halloween", "what day of the week is the 4th of July" ──
    const dayOf = /^what day (?:of the week )?(?:is|does|will) (.+?)(?: fall on| fall| be| land on)?$/.exec(q);
    if (dayOf && !/^(?:it|today)$/.test(dayOf[1])) {
      if (/^tomorrow$/.test(dayOf[1])) return `Tomorrow is ${Talk.dateLong(addDays(now, 1), opts)}.`;
      if (/^yesterday$/.test(dayOf[1])) return `Yesterday was ${Talk.dateLong(addDays(now, -1), opts)}.`;
      const target = this.parse(dayOf[1], now);
      if (!target) return null;
      const days = Talk.calendarDays(target.date, now);
      const verb = days < 0 ? "was" : "is";
      if (days === 0) return `${capitalize(target.label)} is today!`;
      return `${capitalize(target.label)} ${verb} on a ${Talk.weekday(target.date, this.locale)}${days > 0 && days < 60 ? `, ${Talk.duration(days * 24 * HOUR)} from now` : ""}.`;
    }

    // ── "what's the date next Friday", "what date is it in 10 days" ──
    const dateOf = /\bwhat (?:is the )?date (?:is it |will it be |is )?(?:on )?(.+)$/.exec(q);
    if (dateOf && !/^(?:today|now|it|right now)$/.test(dateOf[1])) {
      const target = this.parse(dateOf[1], now);
      if (target && WEEKDAYS.includes(target.label.toLowerCase())) return `${capitalize(target.label)} is ${Talk.monthDay(target.date, this.locale)}.`;
      if (target) return `${capitalize(target.label)} is ${Talk.dateLong(target.date, opts)}.`;
    }

    // ── Plain "what time is it" / "what's the date" / "what day is it" ──
    const asksTime = /\b(?:what time is it|what is the time|time is it|tell me the time|got the time|have the time|current time)\b/.test(q);
    const asksDate = /\b(?:what is the date|todays date|what date is it|what is today|the date today|date is it)\b/.test(q);
    const asksDay = /\b(?:what day is (?:it|today)|which day is (?:it|today)|what day of the week is it)\b/.test(q);
    if (asksTime && (asksDate || asksDay)) return `${Talk.timeNow(now, opts).slice(0, -1)} on ${Talk.dateLong(now, opts)}.`;
    if (asksTime) return Talk.timeNow(now, opts);
    if (asksDate) return `It's ${Talk.dateLong(now, opts)}.`;
    if (asksDay) return `It's ${Talk.weekday(now, this.locale)}${Talk.pick(["", `, the ${Talk.ordinal(now.getDate())}`])}.`;
    if (/\bwhat (?:year|month) is it\b/.test(q)) {
      return /year/.test(q) ? `It's ${now.getFullYear()}.` : `It's ${now.toLocaleDateString(this.locale || "en", { month: "long" })}.`;
    }
    return null;
  }

  /**
   * Parse a spoken moment: "christmas", "friday", "next tuesday", "5 pm",
   * "half past six", "october 31st", "the 4th of july", "10/31", "in 10 days",
   * "the weekend", "my birthday".
   * @param {string} text
   * @param {Date} [now]
   * @returns {{ date: Date, label: string, named?: boolean, timeOfDay?: boolean } | null}
   */
  parse(text, now = new Date()) {
    let t = plain(text)
      .replace(/^(?:the next|next|this|this coming|the|its|it is)\s+(?=\w)/, (m) => (/next/.test(m) ? "next " : ""))
      .replace(/[?.!]+$/, "")
      .trim();
    if (!t) return null;
    const next = /^next /.test(t);
    t = t.replace(/^next /, "");

    // Relative: "in 10 days", "a week from today", "tomorrow", "the day after tomorrow"
    let m = /^(?:in )?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|twelve|fifteen|twenty|thirty) (day|days|week|weeks|month|months)(?: from (?:now|today))?$/.exec(t);
    if (m) {
      const n = /^an?$/.test(m[1]) ? 1 : Number(m[1]) || NUMBER_WORDS[m[1]];
      const date = /month/.test(m[2]) ? addMonths(now, n) : addDays(now, /week/.test(m[2]) ? n * 7 : n);
      return { date, label: `${n === 1 ? `a ${m[2].replace(/s$/, "")}` : `${n} ${m[2]}`} from now` };
    }
    if (t === "tomorrow") return { date: addDays(now, 1), label: "tomorrow" };
    if (t === "the day after tomorrow" || t === "day after tomorrow") return { date: addDays(now, 2), label: "the day after tomorrow" };
    if (t === "weekend" || t === "the weekend") {
      const d = addDays(now, (6 - now.getDay() + 7) % 7 || (now.getDay() === 6 ? 0 : 7));
      return { date: d, label: "the weekend", named: true };
    }

    // Weekdays
    const wd = WEEKDAYS.indexOf(t.replace(/s$/, ""));
    if (wd >= 0) {
      let ahead = (wd - now.getDay() + 7) % 7;
      // "next Thursday" said on a Wednesday means next week's.
      if (ahead === 0 || (next && ahead <= 1)) ahead += 7;
      return { date: addDays(now, ahead), label: Talk.weekday(addDays(now, ahead), this.locale), named: true };
    }

    // Holidays and remembered birthdays
    const holiday = this._holiday(t, now) ?? this._birthday(t, now);
    if (holiday) return holiday;

    // Dates: "october 31st", "oct 31", "the 31st of october", "10/31"
    m = new RegExp(`^${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?(?: (\\d{4}))?$`).exec(t) ??
      new RegExp(`^(?:the )?(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}(?: (\\d{4}))?$`).exec(t);
    if (m) {
      const [monthWord, day] = isNaN(m[1]) ? [m[1], Number(m[2])] : [m[2], Number(m[1])];
      const month = MONTHS.findIndex((name) => name.startsWith(monthWord.slice(0, 3)));
      return this._dateAhead(month, day, now, m[3] ? Number(m[3]) : null);
    }
    m = /^(\d{1,2}) (\d{1,2})$/.exec(t); // "10/31" after normalize()
    if (m) {
      const monthFirst = !this.locale || /^en(-US|-CA)?$/i.test(this.locale);
      const [month, day] = monthFirst ? [Number(m[1]) - 1, Number(m[2])] : [Number(m[2]) - 1, Number(m[1])];
      if (month >= 0 && month < 12) return this._dateAhead(month, day, now);
    }
    m = /^(?:the )?(\d{1,2})(?:st|nd|rd|th)$/.exec(t);
    if (m) {
      const day = Number(m[1]);
      const month = now.getDate() <= day ? now.getMonth() : now.getMonth() + 1;
      const date = new Date(now.getFullYear(), month, day, 12);
      if (date.getDate() === day) return { date, label: `the ${Talk.ordinal(day)}` };
    }

    // Times of day: "5 pm", "5 30", "17 00", "noon", "half past six", "quarter to 7"
    const time = parseTimeOfDay(t);
    if (time) {
      const date = new Date(now);
      date.setHours(time.hours, time.minutes, 0, 0);
      if (date <= now) date.setDate(date.getDate() + 1);
      return { date, label: Talk.clock(date, { hour12: !Talk.uses24h(this.locale) }), timeOfDay: true };
    }
    return null;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _until(target, now) {
    const label = capitalize(target.label);
    this.lastCard = { type: "countdown", label, target: target.date.toISOString(), timeOfDay: Boolean(target.timeOfDay) };
    if (target.timeOfDay) {
      const left = target.date - now;
      return Talk.pick([
        `${label} is ${Talk.duration(left)} away.`,
        `There's ${Talk.duration(left)} until ${target.label}.`,
      ]);
    }
    const days = Talk.calendarDays(target.date, now);
    this.lastCard.days = days;
    if (days === 0) return target.label === "the weekend" ? "It's the weekend already!" : `${label} is today!`;
    if (days === 1) return `${label} is tomorrow.`;
    const on = `${Talk.weekday(target.date, this.locale)}, ${Talk.monthDay(target.date, this.locale)}`;
    if (days < 7) return target.named && WEEKDAYS.includes(target.label.toLowerCase()) ? `${label} is in ${days} days.` : `${label} is on ${on}, ${days} days from now.`;
    if (!target.named) return `${label} is ${days} days away. It's a ${Talk.weekday(target.date, this.locale)}.`;
    return Talk.pick([
      `${label} is ${days} days away, on ${on}.`,
      `There are ${days} days until ${target.label}. It falls on ${on}.`,
    ]);
  }

  /**
   * Local times of places named in a request ("call my mom in London",
   * "the game in Tokyo"), for the language model's context, so it can
   * reason about them instead of guessing: ["London: 3:27 AM Thursday"].
   * @param {string} text
   * @param {Date} [now]
   * @returns {string[]}
   */
  placeTimes(text, now = new Date()) {
    const out = [];
    // A lookahead, so "from paris to los angeles" finds both places.
    for (const m of plain(text).matchAll(/\b(?:in|from|to|at) (?=((?:[a-z]+ ){0,2}[a-z]+))/g)) {
      const words = m[1].split(" ");
      // Try "new york city", then "new york", then "new" – the longest name that is a place.
      for (let n = words.length; n > 0; n--) {
        const place = words.slice(0, n).join(" ");
        const zone = Clock.zoneFor(place);
        if (!zone || zone === localZone()) continue;
        const there = wallClock(now, zone);
        out.push(`${titleCase(place)}: ${Talk.clock(there, { hour12: !Talk.uses24h(this.locale) })} ${Talk.weekday(there, this.locale)}`);
        break;
      }
    }
    return [...new Set(out)];
  }

  /**
   * IANA time zone for a city, region or country name, or null.
   * @param {string} place e.g. "tokyo", "new york", "california", "uk"
   */
  static zoneFor(place) {
    const p = plain(place).replace(/^the /, "").replace(/\s+(?:city|right now|now|today)$/, "").trim();
    if (!p || p.length < 2) return null;
    return PLACES[p] ?? zonesByCity().get(p) ?? zonesByCity().get(p.replace(/^saint /, "st ")) ?? null;
  }

  _timeIn(placeText, now) {
    const place = placeText.replace(/^(?:the )?/, "").replace(/\s+(?:city|right now|now|today)$/, "").trim();
    const zone = Clock.zoneFor(place);
    const name = titleCase(place);
    if (!zone) return `I'm not sure which time zone ${name} is in.`;

    const there = wallClock(now, zone);
    const days = Talk.calendarDays(there, now);
    const time = Talk.clock(there, { hour12: !Talk.uses24h(this.locale) });
    this.lastCard = { type: "clock", city: name, zone };
    const hour = there.getHours();
    const partWords = hour < 12 ? "in the morning" : hour < 17 ? "in the afternoon" : hour < 21 ? "in the evening" : "at night";
    const offsetH = Math.round(((there - now) / HOUR) * 4) / 4;
    const diff = offsetH === 0 ? "the same time as here" : `${Talk.duration(Math.abs(offsetH) * HOUR).replace(/^an hour/, "one hour")} ${offsetH > 0 ? "ahead" : "behind"}`;
    this.lastCard.offset = offsetH === 0 ? "Same time" : `${offsetH > 0 ? "+" : "−"}${Math.abs(offsetH)}h`;
    const dayNote = days > 0 ? `, already ${Talk.weekday(there, this.locale)}` : days < 0 ? `, still ${Talk.weekday(there, this.locale)}` : "";
    const clockOnly = Talk.uses24h(this.locale) ? time : time.replace(/ [AP]M$/, "");
    const spokenTime = /noon|midnight/.test(clockOnly) ? clockOnly : `${clockOnly} ${partWords}`;
    return `In ${name} it's ${spokenTime}${dayNote}. That's ${diff}.`;
  }

  _dateAhead(month, day, now, year = null) {
    let date = new Date(year ?? now.getFullYear(), month, day, 12);
    if (date.getMonth() !== month) return null;
    if (!year && Talk.calendarDays(date, now) < 0) date = new Date(now.getFullYear() + 1, month, day, 12);
    return { date, label: Talk.monthDay(date, this.locale) };
  }

  _holiday(t, now) {
    const fixed = (m, d) => (y) => new Date(y, m, d, 12);
    const nth = (m, weekday, n) => (y) => {
      const first = new Date(y, m, 1, 12);
      return new Date(y, m, 1 + ((weekday - first.getDay() + 7) % 7) + (n - 1) * 7, 12);
    };
    const last = (m, weekday) => (y) => {
      const end = new Date(y, m + 1, 0, 12);
      return new Date(y, m, end.getDate() - ((end.getDay() - weekday + 7) % 7), 12);
    };
    const easter = (y) => {
      const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
      const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
      const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
      const month = Math.floor((h + l - 7 * mm + 114) / 31) - 1;
      return new Date(y, month, ((h + l - 7 * mm + 114) % 31) + 1, 12);
    };
    const shift = (fn, days) => (y) => addDays(fn(y), days);
    const thanksgiving = /^en-CA$/i.test(this.locale ?? "") ? nth(9, 1, 2) : nth(10, 4, 4);

    const HOLIDAYS = [
      [/^christmas eve$/, "Christmas Eve", fixed(11, 24)],
      [/^(?:christmas|xmas|christmas day)$/, "Christmas", fixed(11, 25)],
      [/^boxing day$/, "Boxing Day", fixed(11, 26)],
      [/^new years? eve$/, "New Year's Eve", fixed(11, 31)],
      [/^new years?(?: day)?$/, "New Year's Day", fixed(0, 1)],
      [/^halloween$/, "Halloween", fixed(9, 31)],
      [/^valentines?(?: day)?$/, "Valentine's Day", fixed(1, 14)],
      [/^(?:st|saint) patricks?(?: day)?$/, "St. Patrick's Day", fixed(2, 17)],
      [/^(?:the )?(?:4th|fourth) of july$|^independence day$|^july (?:4th|fourth)$/, "the Fourth of July", fixed(6, 4)],
      [/^canada day$/, "Canada Day", fixed(6, 1)],
      [/^thanksgiving$/, "Thanksgiving", thanksgiving],
      [/^black friday$/, "Black Friday", shift(nth(10, 4, 4), 1)],
      [/^easter(?: sunday)?$/, "Easter", easter],
      [/^good friday$/, "Good Friday", shift(easter, -2)],
      [/^mothers? day$/, "Mother's Day", /^en-GB$/i.test(this.locale ?? "") ? shift(easter, -21) : nth(4, 0, 2)],
      [/^fathers? day$/, "Father's Day", nth(5, 0, 3)],
      [/^memorial day$/, "Memorial Day", last(4, 1)],
      [/^labor day$|^labour day$/, "Labor Day", nth(8, 1, 1)],
      [/^(?:martin luther king|mlk)(?: jr)?(?: day)?$/, "Martin Luther King Day", nth(0, 1, 3)],
      [/^presidents? day$/, "Presidents' Day", nth(1, 1, 3)],
      [/^(?:the )?first day of (?:spring)$/, "the first day of spring", fixed(2, 20)],
      [/^(?:the )?first day of summer$|^summer$/, "the first day of summer", fixed(5, 21)],
      [/^(?:the )?first day of (?:fall|autumn)$|^fall$|^autumn$/, "the first day of fall", fixed(8, 22)],
      [/^(?:the )?first day of winter$|^winter$/, "the first day of winter", fixed(11, 21)],
    ];
    for (const [re, label, dateFor] of HOLIDAYS) {
      if (!re.test(t)) continue;
      let date = dateFor(now.getFullYear());
      if (Talk.calendarDays(date, now) < 0) date = dateFor(now.getFullYear() + 1);
      return { date, label, named: true };
    }
    return null;
  }

  /** "my birthday" / "sam's birthday" from remembered facts like "the user's birthday is March 3rd". */
  _birthday(t, now) {
    const who = /^(my|(\w+)) (birthday|anniversary)$/.exec(t);
    if (!who) return null;
    const person = who[1] === "my" ? "the users" : who[2];
    for (const fact of this.facts()) {
      const f = plain(fact);
      if (!f.includes(`${person} ${who[3]}`)) continue;
      const m = new RegExp(`${MONTH_RE} (\\d{1,2})|(\\d{1,2})(?:st|nd|rd|th)? (?:of )?${MONTH_RE}`).exec(f);
      if (!m) continue;
      const monthWord = m[1] ?? m[4];
      const day = Number(m[2] ?? m[3]);
      const month = MONTHS.findIndex((name) => name.startsWith(monthWord.slice(0, 3)));
      const found = this._dateAhead(month, day, now);
      if (found) return { ...found, label: who[1] === "my" ? `your ${who[3]}` : `${capitalize(who[2].replace(/s$/, ""))}'s ${who[3]}`, named: true };
    }
    return null;
  }
}

/** "5 pm", "5 30 pm", "17 00", "noon", "midnight", "half past six", "quarter to 7" → { hours, minutes }. */
function parseTimeOfDay(t) {
  if (/^(?:noon|midday|lunchtime)$/.test(t)) return { hours: 12, minutes: 0 };
  if (/^midnight$/.test(t)) return { hours: 0, minutes: 0 };
  const word = (w) => (Number.isFinite(Number(w)) ? Number(w) : NUMBER_WORDS[w]);
  let m = /^(half past|quarter past|quarter to|quarter till) (\d{1,2}|\w+)(?: (am|pm|in the morning|in the evening|tonight))?$/.exec(t);
  if (m) {
    let h = word(m[2]);
    if (!Number.isFinite(h)) return null;
    const minutes = { "half past": 30, "quarter past": 15, "quarter to": 45, "quarter till": 45 }[m[1]];
    if (minutes === 45) h -= 1;
    return { hours: to24(h, m[3]), minutes };
  }
  m = /^(\d{1,2})(?: (\d{2}))?(?: ?(am|pm|a m|p m|oclock|o clock|in the morning|in the afternoon|in the evening|tonight))?$/.exec(t);
  if (!m || (!m[2] && !m[3])) return null;
  const h = Number(m[1]);
  const minutes = m[2] ? Number(m[2]) : 0;
  if (h > 23 || minutes > 59) return null;
  return { hours: to24(h, m[3]), minutes };
}

function titleCase(place) {
  return place.replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\b(Uk|Uae|Usa|Utc|Gmt|Nyc|Dc)\b/g, (s) => s.toUpperCase());
}

function localZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Lowercase words without punctuation or apostrophes: "What's 5:30?" → "whats 5 30". */
function plain(text) {
  return normalize(text).replace(/'/g, "");
}

function to24(h, suffix = "") {
  const s = String(suffix ?? "").replace(/\s/g, "");
  if (/^(pm|intheafternoon|intheevening|tonight)$/.test(s)) return h % 12 + 12;
  if (/^(am|inthemorning)$/.test(s)) return h % 12;
  if (h > 12) return h;
  // Bare "5" or "5 o'clock": the next time it comes around is more likely afternoon for 1-7.
  return h >= 1 && h <= 7 ? h + 12 : h;
}

/** The wall-clock time in another zone, as a local Date with the same fields. */
function wallClock(now, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: zone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hour12: false })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return new Date(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute));
}

function addDays(date, n) {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

function addMonths(date, n) {
  const d = new Date(date);
  d.setMonth(d.getMonth() + n);
  return d;
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

Clock.parseTimeOfDay = parseTimeOfDay;
Clock.wallClock = wallClock;
module.exports = Clock;
