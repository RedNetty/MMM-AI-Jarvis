"use strict";

const { isoDate } = require("./text");
const Talk = require("./speech/talk");
const log = require("./log");

const CHECK_MS = 60 * 1000;
const RAIN_CHECK_MS = 10 * 60 * 1000;
const RAIN_REPEAT_MS = 3 * 60 * 60 * 1000;
const TEAM_CHECK_MS = 2 * 60 * 1000;
const BRIEFING_DELAY_MS = 3000;

/**
 * Things IRIS does without being asked, so the mirror feels awake:
 *
 *  - Morning briefing: the first time someone is around in the morning
 *    (heard by the microphone, or a presence sensor such as MMM-PIR-Sensor),
 *    it greets them with the weather, what to wear, their teams' games and
 *    the top headline. Once a day, and never over a conversation.
 *  - Rain alerts: "Heads up, rain is likely in about 40 minutes."
 *  - Team alerts for sports.favorites: kick-off and final score, with the
 *    live scoreboard pinned while the game is on.
 *
 * During quiet hours, or when nobody has been around for a while, alerts
 * are shown on the mirror without speaking.
 */
class Proactive {
  /**
   * @param {object} deps
   * @param {object} deps.config Module config.
   * @param {import("./Skills")} deps.skills
   * @param {(text: string, options: { speak: boolean }) => Promise<void>} deps.notify Show (and maybe say) something.
   * @param {() => boolean} deps.isBusy True while a conversation is going on.
   * @param {() => Date} [deps.now]
   */
  constructor({ config, skills, notify, isBusy, now = () => new Date() }) {
    const p = config.proactive ?? {};
    this.options = {
      enabled: p.enabled !== false,
      briefing: p.briefing !== false,
      briefingHours: p.briefingHours ?? [5, 11],
      rainAlerts: p.rainAlerts !== false,
      teamAlerts: p.teamAlerts !== false,
      quietHours: p.quietHours ?? [22, 7],
      awayAfterMs: (p.awayAfterMinutes ?? 15) * 60 * 1000,
    };
    this.config = config;
    this.skills = skills;
    this.notify = notify;
    this.isBusy = isBusy;
    this.now = now;
    this.lastPresence = 0;
    this.briefedOn = null;
    this.lastRainCheck = 0;
    this.lastRainAlert = 0;
    this.lastTeamCheck = 0;
    /** @type {Map<string, string>} game key → last seen state */
    this.gameStates = new Map();
    this.timer = null;
    this.briefingTimer = null;
  }

  start() {
    if (!this.options.enabled || this.timer) return;
    this.timer = setInterval(() => this.check().catch((err) => log.warn(`Proactive check failed: ${err.message}`)), CHECK_MS);
    this.timer.unref?.();
  }

  stop() {
    clearInterval(this.timer);
    clearTimeout(this.briefingTimer);
    this.timer = null;
  }

  /**
   * Someone is at the mirror (voice, wake word or a presence sensor).
   * @param {"voice"|"sensor"|"query"} [source]
   */
  notePresence(source = "voice") {
    const first = this.now() - this.lastPresence > this.options.awayAfterMs;
    this.lastPresence = this.now().getTime();
    if (!this.options.enabled || !this.options.briefing || !this._briefingDue()) return;
    if (source === "query") {
      // They came to ask something: don't pile a briefing on top of it today.
      this.briefedOn = isoDate(this.now());
      return;
    }
    if (!first && this.briefingTimer) return;
    // Wait a moment: if it was the start of a question, the question wins.
    clearTimeout(this.briefingTimer);
    this.briefingTimer = setTimeout(() => {
      this.briefingTimer = null;
      if (this._briefingDue() && !this.isBusy()) this.briefing().catch((err) => log.warn(`Briefing failed: ${err.message}`));
    }, BRIEFING_DELAY_MS);
    this.briefingTimer.unref?.();
  }

  get someoneAround() {
    return this.now() - this.lastPresence < this.options.awayAfterMs;
  }

  get quiet() {
    const [from, to] = this.options.quietHours ?? [];
    if (from === undefined || to === undefined || from === to) return false;
    const h = this.now().getHours();
    return from < to ? h >= from && h < to : h >= from || h < to;
  }

  /** Run the periodic checks (every minute; each check has its own pace). */
  async check() {
    if (!this.options.enabled) return;
    const now = this.now().getTime();
    const jobs = [];
    if (this.options.rainAlerts && now - this.lastRainCheck >= RAIN_CHECK_MS) {
      this.lastRainCheck = now;
      jobs.push(this.checkRain());
    }
    const favorites = this.config.sports?.favorites ?? [];
    if (this.options.teamAlerts && favorites.length && this.skills.sports && now - this.lastTeamCheck >= TEAM_CHECK_MS) {
      this.lastTeamCheck = now;
      jobs.push(this.checkTeams(favorites));
    }
    await Promise.all(jobs);
  }

  async briefing() {
    this.briefedOn = isoDate(this.now());
    log.info("Proactive: morning briefing.");
    const { spoken } = await this.skills.briefing({ greet: true });
    await this.notify(spoken, { speak: !this.quiet });
  }

  /** Rain likely within the next hour, and it isn't raining yet. */
  async checkRain() {
    if (this.now() - this.lastRainAlert < RAIN_REPEAT_MS) return;
    const w = await this.skills.weather.get("today", this.now()).catch(() => null);
    if (!w?.hours?.length) return;
    if (/rain|drizzle|shower|storm|snow/i.test(w.current?.condition ?? "")) return;
    const now = this.now();
    const soon = w.hours.find((h) => {
      const at = Date.parse(h.time);
      return at > now.getTime() && at - now.getTime() <= 75 * 60 * 1000 && (h.precipChance ?? 0) >= 60 && /rain|drizzle|shower|storm|snow/i.test(h.condition);
    });
    if (!soon) return;
    this.lastRainAlert = now.getTime();
    const minutes = Math.max(10, Math.round((Date.parse(soon.time) - now.getTime()) / 60000 / 5) * 5);
    const what = /snow/i.test(soon.condition) ? "Snow" : /storm|thunder/i.test(soon.condition) ? "A storm" : "Rain";
    const text = `Heads up: ${what.toLowerCase() === "rain" ? "rain is" : `${what.toLowerCase()} is`} likely in about ${Talk.duration(minutes * 60000)}. You might want an umbrella.`;
    log.info(`Proactive: ${text}`);
    this.skills.info.showWeather(w);
    await this.notify(text, { speak: this.someoneAround && !this.quiet });
  }

  /** Kick-off and final score for the user's teams. */
  async checkTeams(favorites) {
    for (const team of favorites) {
      const game = await this.skills.sports.findGame(team).catch(() => null);
      if (!game) continue;
      const key = `${game.league.key}:${game.id}`;
      const before = this.gameStates.get(key);
      this.gameStates.set(key, game.state);
      if (!before || before === game.state) continue;

      let text = null;
      if (before === "pre" && game.state === "in") {
        text = `The ${capitalize(team)} game just started. ${this.skills.sports.describe(game)}`;
        await this.skills.showScore(team).catch(() => null);
      } else if (game.state === "post") {
        text = `Final: ${lowerFirst(this.skills.sports.describe(game))}`;
        await this.skills.showScore(team).catch(() => null);
      }
      if (text) {
        log.info(`Proactive: ${text}`);
        await this.notify(text, { speak: this.someoneAround && !this.quiet });
      }
    }
  }

  _briefingDue() {
    const now = this.now();
    const [from, to] = this.options.briefingHours;
    const h = now.getHours();
    return h >= from && h < to && this.briefedOn !== isoDate(now);
  }
}

function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function lowerFirst(s) {
  return s ? s.replace(/^The /, "the ") : s;
}

module.exports = Proactive;
