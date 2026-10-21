"use strict";

const Talk = require("./talk");
const { normalize } = require("../text");

/**
 * Weather the way a person tells it: "It's 15° and sunny right now, but it
 * feels more like 11. Down to 9 tonight, and it should stay dry."
 * Not a data dump ("Now: 15 degrees (feels like 11 degrees), clear, wind
 * 14 km/h. Today: sunny, high 21…").
 *
 * Works on the normalised weather object from Weather.js, including the
 * optional `window` (tonight, tomorrow morning, …) built from hourly data.
 */

/** Condition → how you'd say the sky is ("It's ___"). */
function sky(condition, { night = false } = {}) {
  const c = String(condition ?? "").toLowerCase();
  if (!c) return "";
  if (/thunder|storm/.test(c)) return "stormy";
  if (/heavy rain|violent|pour/.test(c)) return "pouring";
  if (/freezing (rain|drizzle)/.test(c)) return "icy with freezing rain";
  if (/sleet/.test(c)) return "sleeting";
  if (/heavy snow/.test(c)) return "snowing heavily";
  if (/snow/.test(c)) return "snowing";
  if (/drizzle|sprinkle/.test(c)) return "drizzly";
  if (/shower/.test(c)) return "showery";
  if (/light rain/.test(c)) return "raining lightly";
  if (/rain/.test(c)) return "raining";
  if (/fog|mist|haze/.test(c)) return "foggy";
  if (/overcast/.test(c)) return "overcast";
  if (/partly|few clouds|scattered|mainly clear|mostly clear/.test(c)) return night ? "mostly clear" : "partly sunny";
  if (/cloud/.test(c)) return "cloudy";
  if (/clear|sun|fair/.test(c)) return night ? "clear" : "sunny";
  if (/wind/.test(c)) return "windy";
  return c;
}

/** Condition → what's expected ("expect ___"). */
function expected(condition) {
  const c = String(condition ?? "").toLowerCase();
  if (/thunder|storm/.test(c)) return "thunderstorms";
  if (/snow/.test(c)) return c.includes("heavy") ? "heavy snow" : "snow";
  if (/drizzle/.test(c)) return "drizzle";
  if (/shower/.test(c)) return "showers";
  if (/rain/.test(c)) return c.includes("heavy") ? "heavy rain" : c.includes("light") ? "light rain" : "rain";
  return c;
}

const isWet = (c) => /rain|drizzle|shower|storm|snow|sleet/i.test(String(c ?? ""));

/** °C feel words. */
function feel(c) {
  if (c < 0) return "freezing";
  if (c < 7) return "cold";
  if (c < 13) return "chilly";
  if (c < 19) return "cool";
  if (c < 25) return "mild";
  if (c < 30) return "warm";
  return "hot";
}

class WeatherTalk {
  /**
   * @param {object} w Normalised weather (see Weather.js).
   * @param {{ now?: Date }} [options]
   */
  constructor(w, { now = new Date() } = {}) {
    this.w = w;
    this.now = now;
    this.imperial = w.units?.temp === "°F";
  }

  deg(v) {
    return `${Math.round(v)}°`;
  }

  toC(v) {
    return this.imperial ? ((v - 32) * 5) / 9 : v;
  }

  get windy() {
    const v = this.w.current?.wind ?? this.w.window?.wind ?? this.w.day?.wind;
    if (v === null || v === undefined) return false;
    return (this.w.units?.wind === "mph" ? v * 1.609 : v) >= 30;
  }

  /** Rain chance for the part of the day being talked about. */
  get rainChance() {
    return this.w.window?.precipChance ?? this.w.day?.precipChance ?? null;
  }

  get scopeLabel() {
    return this.w.window?.label ?? this.w.day?.label ?? "today";
  }

  /**
   * Answer a weather question.
   * @param {string} [question]
   */
  answer(question = "") {
    const q = normalize(question);
    if (/\b(rain|raining|umbrella|wet|showers?|drizzle|storm|storms|thunder)\b/.test(q)) return this.rain();
    if (/\bsnow(ing|y)?\b/.test(q)) return this.snow();
    if (/\b(jacket|coat|layers?|sweater|jumper|hoodie|bundle up|shorts|sunscreen)\b/.test(q)) return this.jacket(q);
    if (/\b(wind|windy|breezy|gusty)\b/.test(q)) return this.wind();
    if (/\b(how (?:cold|hot|warm|chilly)|temperature|degrees|cold|hot|warm|chilly)\b/.test(q)) return this.temperature();
    return this.overview();
  }

  overview() {
    const { w } = this;
    const sentences = [];

    if (w.window) {
      const win = w.window;
      const range = this.rangeWords(win.low, win.high);
      const sk = sky(win.condition, { night: /night|evening/.test(win.label) });
      sentences.push(`${cap(win.label)} looks ${sk || "fine"}${range ? `, ${range}` : ""}.`);
      sentences.push(this.rainSentence(win.precipChance, win.condition, win.label));
      return sentences.filter(Boolean).join(" ");
    }

    if (w.current) {
      const c = w.current;
      const night = this.now.getHours() >= 19 || this.now.getHours() < 6;
      const sk = sky(c.condition, { night });
      sentences.push(
        Talk.pick([
          `It's ${this.deg(c.temperature)}${sk ? ` and ${sk}` : ""} right now`,
          `Right now it's ${this.deg(c.temperature)}${sk ? ` and ${sk}` : ""}`,
        ]) + this.feelsLikeClause() + ".",
      );
      sentences.push(this.restOfDay());
    } else if (w.day) {
      const d = w.day;
      const sk = sky(d.condition);
      sentences.push(`${cap(d.label)} looks ${sk || "mixed"}${this.highLow(d) ? `, with ${this.highLow(d)}` : ""}.`);
      sentences.push(this.rainSentence(d.precipChance, d.condition, d.label));
    }
    if (this.windy) sentences.push(Talk.pick(["It's windy out, too.", "Expect a strong breeze."]));
    return sentences.filter(Boolean).join(" ") || "I don't have a forecast right now.";
  }

  rain() {
    const chance = this.rainChance;
    const label = this.scopeLabel;
    const condition = this.w.window?.condition ?? `${this.w.current?.condition ?? ""} ${this.w.day?.condition ?? ""}`;
    const nowWet = /rain|drizzle|shower|storm/i.test(this.w.current?.condition ?? "") && !this.w.window && this.w.day?.label === "today";
    if (nowWet) return `Yes, it's ${sky(this.w.current.condition)} right now, so take an umbrella.`;
    if (chance === null) {
      return isWet(condition) ? `Yes, expect ${expected(condition)} ${label}. Take an umbrella.` : `It doesn't look rainy ${label}.`;
    }
    const pct = Math.round(chance);
    if (pct >= 60) return Talk.pick([`Yes, take an umbrella. Rain's likely ${label}, about ${pct}%.`, `I'd bring an umbrella. There's a ${pct}% chance of rain ${label}.`]);
    if (pct >= 30) return Talk.pick([`Maybe. There's a ${pct}% chance of rain ${label}, so a small umbrella wouldn't hurt.`, `It might. Rain's a ${pct}% chance ${label}.`]);
    if (pct >= 10) return `Probably not. Only a ${pct}% chance of rain ${label}.`;
    return Talk.pick([`No, it should stay dry ${label}.`, `No rain expected ${label}.`, `Nope, it looks dry ${label}.`]);
  }

  snow() {
    const condition = this.w.window?.condition ?? `${this.w.current?.condition ?? ""} ${this.w.day?.condition ?? ""}`;
    const label = this.scopeLabel;
    if (/snow/i.test(condition)) return `Yes, ${expected(condition)} is in the forecast ${label}.`;
    const low = this.w.window?.low ?? this.w.day?.low;
    if (low !== null && low !== undefined && this.toC(low) > 3) return `No, it's too warm for snow ${label}.`;
    return `No snow in the forecast ${label}.`;
  }

  temperature() {
    const { w } = this;
    if (w.window) {
      const range = this.rangeWords(w.window.low, w.window.high);
      return `${cap(w.window.label)} it'll be ${feel(this.toC(w.window.high ?? w.window.low))}${range ? `, ${range}` : ""}.`;
    }
    if (w.current) {
      const c = w.current;
      const mood = feel(this.toC(c.temperature));
      const lead = Talk.pick([`It's ${this.deg(c.temperature)} right now`, `It's a ${mood} ${this.deg(c.temperature)} right now`]);
      return `${lead}${this.feelsLikeClause()}. ${this.restOfDay({ withRain: false })}`.trim();
    }
    if (w.day) return `${cap(w.day.label)} will be ${feel(this.toC(((w.day.high ?? 0) + (w.day.low ?? w.day.high ?? 0)) / 2))}, with ${this.highLow(w.day)}.`;
    return "I don't have the temperature right now.";
  }

  jacket(q) {
    const { w } = this;
    const feels = !w.window && w.current?.feelsLike !== null && w.current?.feelsLike !== undefined;
    const ref = w.window ? (w.window.low ?? w.window.high) : feels ? w.current.feelsLike : (w.current?.temperature ?? w.day?.low ?? w.day?.high);
    if (ref === null || ref === undefined) return "I can't tell without a forecast.";
    const c = this.toC(ref);
    const wet = (this.rainChance ?? 0) >= 50 || isWet(w.window?.condition ?? w.current?.condition);
    const temp = this.deg(ref);
    const asksShorts = /\bshorts\b/.test(q);
    if (asksShorts) {
      const high = w.window?.high ?? (w.current ? w.current.temperature : w.day?.high) ?? ref;
      const future = Boolean(w.window || !w.current);
      return this.toC(high) >= 22
        ? `Yes, it's shorts weather${future ? `, up to ${this.deg(high)}` : `, ${this.deg(high)}`}.`
        : `I wouldn't. ${future ? "It'll only get to" : "It's only"} ${this.deg(high)}${this.toC(high) < 15 ? ", that's chilly for shorts" : ""}.`;
    }
    if (/sunscreen/.test(q)) return (w.day?.uv ?? 0) >= 3 ? `Yes, the UV index gets to ${Math.round(w.day.uv)} today.` : "You should be fine without it today.";
    if (c < 7) return `Yes, bundle up. ${w.window ? "It'll feel like" : "It feels like"} ${temp}${wet ? " and it's wet" : ""}, so wear a warm coat.`;
    if (c < 13) return `Yes, it's chilly, ${temp}. A proper jacket's a good idea${wet ? ", ideally a waterproof one" : ""}.`;
    if (c < 19) return `A light jacket should do. It ${w.window ? "will be" : feels ? "feels like" : "is"} about ${temp}${wet ? " and it may rain" : ""}.`;
    return wet ? `It's warm, ${temp}, but it might rain, so a light rain jacket.` : `No, it's ${temp}. You'll be fine without one.`;
  }

  wind() {
    const v = this.w.current?.wind ?? this.w.window?.wind ?? this.w.day?.wind;
    if (v === null || v === undefined) return "I don't have the wind speed right now.";
    const unit = this.w.units?.wind ?? "km/h";
    const kmh = unit === "mph" ? v * 1.609 : v;
    const words = kmh < 12 ? "barely any wind" : kmh < 25 ? "a light breeze" : kmh < 40 ? "a fair breeze" : kmh < 60 ? "strong wind" : "very strong, gusty wind";
    return `There's ${words}, around ${Math.round(v)} ${unit}.`;
  }

  // ─── Pieces ────────────────────────────────────────────────────────────

  feelsLikeClause() {
    const c = this.w.current;
    if (!c || c.feelsLike === null || c.feelsLike === undefined) return "";
    const diff = c.feelsLike - c.temperature;
    if (Math.abs(diff) < (this.imperial ? 5 : 3)) return "";
    return diff < 0
      ? `, ${this.windy ? "but with the wind it feels more like" : "but it feels more like"} ${this.deg(c.feelsLike)}`
      : `, though it feels more like ${this.deg(c.feelsLike)}`;
  }

  /** What the rest of today does, phrased for the time of day it is now. */
  restOfDay({ withRain = true } = {}) {
    const d = this.w.day;
    if (!d) return "";
    const hour = this.now.getHours();
    const later = this.w.later; // remaining hours of today, when hourly data exists
    const rainChance = later?.precipChance ?? d.precipChance;
    const rain = withRain ? this.rainSentence(rainChance, later?.condition ?? d.condition, hour >= 17 ? "tonight" : "later") : "";
    let temps = "";
    if (hour >= 17) {
      const low = later?.low ?? d.low;
      temps = low !== null && low !== undefined ? Talk.pick([`Down to ${this.deg(low)} tonight.`, `It'll drop to about ${this.deg(low)} tonight.`]) : "";
    } else if (hour >= 12) {
      const high = later?.high ?? d.high;
      const low = later?.low ?? d.low;
      const nowT = this.w.current?.temperature;
      const warmer = high !== null && high !== undefined && (nowT === null || nowT === undefined || high > nowT + 1);
      if (warmer) temps = `Up to ${this.deg(high)} this afternoon${low !== null && low !== undefined ? `, then down to ${this.deg(low)} tonight` : ""}.`;
      else if (low !== null && low !== undefined) temps = `It'll cool down to ${this.deg(low)} tonight.`;
    } else {
      temps = d.high !== null ? Talk.pick([`It'll get up to ${this.deg(d.high)} later.`, `Expect a high of ${this.deg(d.high)}${d.low !== null ? ` and a low of ${this.deg(d.low)}` : ""}.`]) : "";
    }
    return [temps, rain].filter(Boolean).join(" ");
  }

  rainSentence(chance, condition, label) {
    const when = label === "later" ? "later" : label;
    if (chance === null || chance === undefined) return isWet(condition) ? `Expect ${expected(condition)} ${when}.` : "";
    const pct = Math.round(chance);
    if (pct >= 60) return `${cap(expected(condition) || "rain")} is likely ${when}, so take an umbrella.`;
    if (pct >= 30) return `There's a ${pct}% chance of rain ${when}.`;
    return Talk.pick(["It should stay dry.", "No rain on the way.", "And it looks dry."]);
  }

  highLow(d) {
    if (d.high === null || d.high === undefined) return "";
    return d.low !== null && d.low !== undefined ? `a high of ${this.deg(d.high)} and a low of ${this.deg(d.low)}` : `a high of ${this.deg(d.high)}`;
  }

  rangeWords(low, high) {
    if (high === null || high === undefined) return low === null || low === undefined ? "" : `around ${this.deg(low)}`;
    if (low === null || low === undefined || Math.round(high) - Math.round(low) <= 2) return `around ${this.deg(high)}`;
    return `between ${this.deg(low)} and ${this.deg(high)}`;
  }
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

WeatherTalk.sky = sky;
WeatherTalk.feel = feel;
module.exports = WeatherTalk;
