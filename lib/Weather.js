"use strict";

const log = require("./log");
const { isoDate, normalize } = require("./text");

const CACHE_MS = 15 * 60 * 1000;
const MIRROR_MAX_AGE_MS = 3 * 60 * 60 * 1000;

// WMO weather interpretation codes used by Open-Meteo.
const WMO = {
  0: "clear sky",
  1: "mainly clear",
  2: "partly cloudy",
  3: "overcast",
  45: "fog",
  48: "freezing fog",
  51: "light drizzle",
  53: "drizzle",
  55: "heavy drizzle",
  56: "freezing drizzle",
  57: "heavy freezing drizzle",
  61: "light rain",
  63: "rain",
  65: "heavy rain",
  66: "freezing rain",
  67: "heavy freezing rain",
  71: "light snow",
  73: "snow",
  75: "heavy snow",
  77: "snow grains",
  80: "light showers",
  81: "showers",
  82: "violent showers",
  85: "snow showers",
  86: "heavy snow showers",
  95: "thunderstorm",
  96: "thunderstorm with hail",
  99: "severe thunderstorm with hail",
};

/**
 * Parts of the day people ask about. Hours are [from, to) in local time;
 * `day` is 0 for today, 1 for tomorrow.
 */
const WINDOWS = [
  { re: /\btomorrow (?:morning|am)\b/, day: 1, from: 6, to: 12, label: "tomorrow morning" },
  { re: /\btomorrow afternoon\b/, day: 1, from: 12, to: 17, label: "tomorrow afternoon" },
  { re: /\btomorrow (?:evening|night)\b/, day: 1, from: 17, to: 24, label: "tomorrow evening" },
  { re: /\btonight\b|\bthis evening\b|\blater tonight\b/, day: 0, from: 18, to: 24, label: "tonight" },
  { re: /\bthis morning\b/, day: 0, from: 6, to: 12, label: "this morning" },
  { re: /\bthis afternoon\b/, day: 0, from: 12, to: 17, label: "this afternoon" },
  { re: /\b(?:later|later on|later today|rest of the day)\b/, day: 0, from: null, to: 24, label: "later" },
];

/**
 * Weather for answers and outfit planning.
 *
 * Sources, in order of preference:
 *  1. Open-Meteo, when latitude/longitude are configured (free, no API key),
 *     including hourly data so "tonight" and "tomorrow morning" are real.
 *  2. The MagicMirror weather module's WEATHER_UPDATED broadcast – no extra
 *     network calls at all; reuses what your mirror already shows (with its
 *     hourly forecast when the module provides one).
 *
 * Normalised result:
 * {
 *   source, location, units: { temp, wind },
 *   current: { temperature, feelsLike, humidity, wind, condition } | null,
 *   day:     { label, high, low, precipChance, condition, uv, wind } | null,
 *   window:  { label, high, low, precipChance, condition, wind } | null  – the asked-about part of the day
 *   later:   { … same … } | null  – the rest of today (today only)
 * }
 */
class Weather {
  /**
   * @param {{ latitude?: number|null, longitude?: number|null, units?: "metric"|"imperial", locationName?: string }} options
   */
  constructor({ latitude = null, longitude = null, units = "metric", locationName = "" } = {}) {
    this.latitude = latitude;
    this.longitude = longitude;
    this.units = units === "imperial" ? "imperial" : "metric";
    this.locationName = locationName;
    this.cache = null;
    this.mirror = null;
  }

  get hasCoordinates() {
    return Number.isFinite(this.latitude) && Number.isFinite(this.longitude);
  }

  /**
   * Store the summary forwarded by the front-end from WEATHER_UPDATED.
   * MagicMirror 2.38 sends values in the weather module's own units:
   * metric = °C and m/s, imperial = °F and mph. `summary.units` says which.
   * @param {object} summary
   */
  updateFromMirror(summary) {
    if (!summary || typeof summary !== "object") return;
    this.mirror = { ...summary, receivedAt: Date.now() };
  }

  /**
   * Which part of which day a question is about: "tonight", "tomorrow
   * morning", "later". "tomorrow" alone is the whole day; anything else is
   * today (null window).
   * @param {string} text
   * @param {Date} [now]
   * @returns {{ day: 0|1, from: number|null, to: number, label: string } | { day: 0|1 }}
   */
  static parseWhen(text, now = new Date()) {
    const q = normalize(text);
    for (const w of WINDOWS) {
      if (!w.re.test(q)) continue;
      const from = w.from ?? now.getHours() + 1;
      // "tonight" asked at 10 PM starts now, not at 6.
      const start = w.day === 0 ? Math.max(from, now.getHours()) : from;
      if (w.day === 0 && start >= w.to) break;
      return { day: w.day, from: start, to: w.to, label: w.label };
    }
    return { day: /\btomorrow\b/.test(q) ? 1 : 0 };
  }

  /**
   * @param {"today"|"tomorrow"|{ day: 0|1, from?: number|null, to?: number, label?: string }} [when="today"]
   * @param {Date} [now]
   * @returns {Promise<object|null>}
   */
  async get(when = "today", now = new Date()) {
    const spec = typeof when === "string" ? { day: when === "tomorrow" ? 1 : 0 } : when;

    if (this.hasCoordinates) {
      try {
        return this._fromOpenMeteo(await this._fetchOpenMeteo(), spec, now);
      } catch (err) {
        log.warn(`Open-Meteo request failed: ${err.message}`);
      }
    }

    if (this.mirror && Date.now() - this.mirror.receivedAt < MIRROR_MAX_AGE_MS) {
      return this._fromMirror(spec, now);
    }
    return null;
  }

  /**
   * Compact factual description, for language-model prompts (not for speech;
   * see speech/weatherTalk.js for that).
   * @param {object|null} w
   */
  static describe(w) {
    if (!w) return "Weather unavailable.";
    const t = w.units.temp;
    const parts = [];
    if (w.location) parts.push(`Location: ${w.location}.`);
    if (w.current) {
      const c = w.current;
      parts.push(
        `Now: ${fmt(c.temperature)}${t}${c.feelsLike !== null ? ` (feels like ${fmt(c.feelsLike)}${t})` : ""}` +
          `${c.condition ? `, ${c.condition}` : ""}${c.wind !== null ? `, wind ${fmt(c.wind)} ${w.units.wind}` : ""}.`,
      );
    }
    const summarize = (label, d) => {
      const range = d.high !== null && d.low !== null ? `high ${fmt(d.high)}${t}, low ${fmt(d.low)}${t}` : "";
      const rain = d.precipChance !== null ? `${fmt(d.precipChance)}% chance of precipitation` : "";
      const uv = d.uv !== null && d.uv !== undefined ? `UV index ${fmt(d.uv)}` : "";
      return `${capitalize(label)}: ${[d.condition, range, rain, uv].filter(Boolean).join(", ")}.`;
    };
    if (w.day) parts.push(summarize(w.day.label, w.day));
    if (w.window) parts.push(summarize(w.window.label, w.window));
    return parts.join(" ");
  }

  // ─── Open-Meteo ────────────────────────────────────────────────────────

  async _fetchOpenMeteo() {
    if (this.cache && Date.now() - this.cache.at < CACHE_MS) return this.cache.data;

    const imperial = this.units === "imperial";
    const params = new URLSearchParams({
      latitude: String(this.latitude),
      longitude: String(this.longitude),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m",
      hourly: "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max",
      // The mirror's own zone, so hourly times line up with "tonight" here.
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "auto",
      forecast_days: "3",
      temperature_unit: imperial ? "fahrenheit" : "celsius",
      wind_speed_unit: imperial ? "mph" : "kmh",
    });

    const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    this.cache = { at: Date.now(), data };
    return data;
  }

  _fromOpenMeteo(data, spec, now) {
    const c = data.current ?? {};
    const d = data.daily ?? {};
    const index = spec.day;
    const at = (arr) => (Array.isArray(arr) && arr[index] !== undefined ? arr[index] : null);

    const h = data.hourly ?? {};
    const hours = (h.time ?? []).map((time, i) => ({
      time: new Date(time),
      temperature: h.temperature_2m?.[i],
      precipChance: h.precipitation_probability?.[i],
      condition: WMO[h.weather_code?.[i]] ?? "",
      code: h.weather_code?.[i],
      wind: h.wind_speed_10m?.[i],
    }));

    return {
      source: "open-meteo",
      location: this.locationName,
      units: this._units(),
      current:
        index === 0
          ? {
              temperature: num(c.temperature_2m),
              feelsLike: num(c.apparent_temperature),
              humidity: num(c.relative_humidity_2m),
              wind: num(c.wind_speed_10m),
              condition: WMO[c.weather_code] ?? "",
            }
          : null,
      day: {
        label: index === 0 ? "today" : "tomorrow",
        high: num(at(d.temperature_2m_max)),
        low: num(at(d.temperature_2m_min)),
        precipChance: num(at(d.precipitation_probability_max)),
        condition: WMO[at(d.weather_code)] ?? "",
        uv: num(at(d.uv_index_max)),
        wind: num(at(d.wind_speed_10m_max)),
      },
      ...this._windows(hours, spec, now),
    };
  }

  // ─── MagicMirror weather module ────────────────────────────────────────

  _fromMirror(spec, now) {
    const m = this.mirror;
    const index = spec.day;
    const sourceImperial = m.units === "imperial";
    const wantImperial = this.units === "imperial";

    const toTemp = (v) => {
      if (v === null || v === undefined) return null;
      if (sourceImperial === wantImperial) return v;
      return wantImperial ? (v * 9) / 5 + 32 : ((v - 32) * 5) / 9;
    };
    const toWind = (v) => {
      if (v === null || v === undefined) return null;
      const ms = sourceImperial ? v / 2.23694 : v;
      return wantImperial ? ms * 2.23694 : ms * 3.6;
    };
    const forecast = m.forecast?.[index] ?? null;
    const hours = (m.hourly ?? []).map((x) => ({
      time: new Date(x.time),
      temperature: toTemp(x.temperature),
      precipChance: x.precipitationProbability ?? null,
      condition: humanize(x.weatherType),
      code: null,
      wind: toWind(x.windSpeed),
    }));

    return {
      source: "magicmirror",
      location: m.locationName || this.locationName,
      units: this._units(),
      current:
        index === 0 && m.current
          ? {
              temperature: num(toTemp(m.current.temperature)),
              feelsLike: num(toTemp(m.current.feelsLike)),
              humidity: num(m.current.humidity),
              wind: num(toWind(m.current.windSpeed)),
              condition: humanize(m.current.weatherType),
            }
          : null,
      day: forecast
        ? {
            label: index === 0 ? "today" : "tomorrow",
            high: num(toTemp(forecast.maxTemperature)),
            low: num(toTemp(forecast.minTemperature)),
            precipChance: num(forecast.precipitationProbability),
            condition: humanize(forecast.weatherType),
            uv: null,
            wind: num(toWind(forecast.windSpeed)),
          }
        : null,
      ...this._windows(hours, spec, now),
    };
  }

  // ─── Hourly windows ────────────────────────────────────────────────────

  /**
   * Summaries of the asked-about window and the rest of today, from hourly data.
   * @returns {{ window: object|null, later: object|null }}
   */
  _windows(hours, spec, now) {
    const valid = hours.filter((x) => Number.isFinite(x.time.getTime()));
    if (valid.length === 0) return { window: null, later: null };
    const dayStr = (offset) => {
      const d = new Date(now);
      d.setDate(d.getDate() + offset);
      return isoDate(d);
    };
    const slice = (offset, from, to) =>
      valid.filter((x) => isoDate(x.time) === dayStr(offset) && x.time.getHours() >= from && x.time.getHours() < to);

    let window = null;
    if (spec.label) {
      window = summarizeHours(slice(spec.day, spec.from ?? 0, spec.to ?? 24), spec.label);
    }
    const later = spec.day === 0 ? summarizeHours(slice(0, now.getHours() + 1, 24), "later") : null;
    return { window, later };
  }

  _units() {
    return this.units === "imperial" ? { temp: "°F", wind: "mph" } : { temp: "°C", wind: "km/h" };
  }
}

/** Collapse hourly rows into { label, high, low, precipChance, condition, wind }. */
function summarizeHours(rows, label) {
  if (rows.length === 0) return null;
  const nums = (key) => rows.map((r) => r[key]).filter((v) => v !== null && v !== undefined && Number.isFinite(Number(v))).map(Number);
  const temps = nums("temperature");
  const rain = nums("precipChance");
  const wind = nums("wind");

  // The wettest likely condition if rain is a real chance, otherwise the most common one.
  const wet = rows.filter((r) => /rain|drizzle|shower|snow|storm|sleet/i.test(r.condition) && (r.precipChance ?? 100) >= 30);
  let condition;
  if (wet.length) {
    condition = wet.sort((a, b) => (b.code ?? 0) - (a.code ?? 0))[0].condition;
  } else {
    const counts = new Map();
    for (const r of rows) if (r.condition) counts.set(r.condition, (counts.get(r.condition) ?? 0) + 1);
    condition = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
  }

  return {
    label,
    high: temps.length ? num(Math.max(...temps)) : null,
    low: temps.length ? num(Math.min(...temps)) : null,
    precipChance: rain.length ? num(Math.max(...rain)) : null,
    condition,
    wind: wind.length ? num(Math.max(...wind)) : null,
  };
}

function num(v) {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) ? null : Math.round(n * 10) / 10;
}

function fmt(v) {
  return Math.round(v);
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** MagicMirror weather types look like "day-sunny" or "night-alt-rain". */
function humanize(type) {
  if (!type) return "";
  return String(type)
    .replace(/^(day|night)-(alt-)?/, "")
    .replace(/-/g, " ")
    .trim();
}

Weather.WMO = WMO;
Weather.summarizeHours = summarizeHours;
module.exports = Weather;
