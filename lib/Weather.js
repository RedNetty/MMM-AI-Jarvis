"use strict";

const log = require("./log");

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
 * Weather for outfit planning.
 *
 * Sources, in order of preference:
 *  1. Open-Meteo, when latitude/longitude are configured (free, no API key).
 *  2. The MagicMirror weather module's WEATHER_UPDATED broadcast – no extra
 *     network calls at all; Jarvis reuses what your mirror already shows.
 *
 * Normalised result:
 * {
 *   source, location, units: { temp, wind },
 *   current: { temperature, feelsLike, humidity, wind, condition } | null,
 *   day: { label, high, low, precipChance, condition, uv, wind } | null
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
   * @param {"today"|"tomorrow"} [day="today"]
   * @returns {Promise<object|null>}
   */
  async get(day = "today") {
    const index = day === "tomorrow" ? 1 : 0;

    if (this.hasCoordinates) {
      try {
        return this._fromOpenMeteo(await this._fetchOpenMeteo(), index);
      } catch (err) {
        log.warn(`Open-Meteo request failed: ${err.message}`);
      }
    }

    if (this.mirror && Date.now() - this.mirror.receivedAt < MIRROR_MAX_AGE_MS) {
      return this._fromMirror(index);
    }
    return null;
  }

  /**
   * Short natural-language description for prompts.
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
    if (w.day) {
      const d = w.day;
      const range = d.high !== null && d.low !== null ? `high ${fmt(d.high)}${t}, low ${fmt(d.low)}${t}` : "";
      const rain = d.precipChance !== null ? `${fmt(d.precipChance)}% chance of precipitation` : "";
      const uv = d.uv !== null ? `UV index ${fmt(d.uv)}` : "";
      parts.push(`${capitalize(d.label)}: ${[d.condition, range, rain, uv].filter(Boolean).join(", ")}.`);
    }
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
      daily:
        "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,uv_index_max,wind_speed_10m_max",
      timezone: "auto",
      forecast_days: "2",
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

  _fromOpenMeteo(data, index) {
    const c = data.current ?? {};
    const d = data.daily ?? {};
    const at = (arr) => (Array.isArray(arr) && arr[index] !== undefined ? arr[index] : null);

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
    };
  }

  // ─── MagicMirror weather module ────────────────────────────────────────

  _fromMirror(index) {
    const m = this.mirror;
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
    };
  }

  _units() {
    return this.units === "imperial" ? { temp: "°F", wind: "mph" } : { temp: "°C", wind: "km/h" };
  }
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
module.exports = Weather;
