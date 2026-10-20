"use strict";

const { normalize } = require("./text");
const log = require("./log");

const BASE = "https://site.api.espn.com/apis/site/v2/sports";
const SCOREBOARD_CACHE_MS = 20 * 1000;
const TEAMS_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Leagues Jarvis knows about. `aliases` are words people use when asking
 * ("premier league", "prem", "footy"); they are matched and stripped from
 * the team query.
 */
const LEAGUES = {
  nfl: { path: "football/nfl", name: "NFL", aliases: ["nfl", "football"] },
  ncaaf: { path: "football/college-football", name: "College Football", aliases: ["college football", "ncaa football", "ncaaf"] },
  nba: { path: "basketball/nba", name: "NBA", aliases: ["nba", "basketball"] },
  wnba: { path: "basketball/wnba", name: "WNBA", aliases: ["wnba"] },
  ncaab: { path: "basketball/mens-college-basketball", name: "College Basketball", aliases: ["college basketball", "ncaab", "march madness"] },
  mlb: { path: "baseball/mlb", name: "MLB", aliases: ["mlb", "baseball"] },
  nhl: { path: "hockey/nhl", name: "NHL", aliases: ["nhl", "hockey"] },
  epl: { path: "soccer/eng.1", name: "Premier League", aliases: ["premier league", "epl", "prem"] },
  championship: { path: "soccer/eng.2", name: "Championship", aliases: ["championship", "efl"] },
  laliga: { path: "soccer/esp.1", name: "LaLiga", aliases: ["la liga", "laliga"] },
  bundesliga: { path: "soccer/ger.1", name: "Bundesliga", aliases: ["bundesliga"] },
  seriea: { path: "soccer/ita.1", name: "Serie A", aliases: ["serie a"] },
  ligue1: { path: "soccer/fra.1", name: "Ligue 1", aliases: ["ligue 1", "ligue un"] },
  mls: { path: "soccer/usa.1", name: "MLS", aliases: ["mls", "major league soccer"] },
  ucl: { path: "soccer/uefa.champions", name: "Champions League", aliases: ["champions league", "ucl"] },
  uel: { path: "soccer/uefa.europa", name: "Europa League", aliases: ["europa league", "uel"] },
};

const FILLER = /\b(the|game|match|score|scores|result|results|latest|live|today|tonight|now|current|currently|right|please|playing|play|team|fc|vs|versus|against|and|how|are|is|was|did|do|doing|what|whats|what s|show|me|tell|check|get|update)\b/g;

/**
 * Live sports scores from ESPN's public JSON feeds (no API key needed).
 *
 * Normalised game shape:
 * {
 *   id, league: { key, name }, state: "pre" | "in" | "post", detail, clock, period, date,
 *   home: { name, short, abbr, logo, score, winner }, away: { … }
 * }
 */
class Sports {
  /**
   * @param {{ leagues?: string[], locale?: string }} [options]
   *   leagues: keys from Sports.LEAGUES searched when no league is named.
   */
  constructor({ leagues = ["nfl", "nba", "mlb", "nhl", "epl", "mls", "ucl", "laliga", "bundesliga", "seriea"], locale } = {}) {
    this.leagues = leagues.filter((k) => {
      if (LEAGUES[k]) return true;
      log.warn(`Unknown league "${k}" in sports.leagues; ignoring. Valid: ${Object.keys(LEAGUES).join(", ")}`);
      return false;
    });
    this.locale = locale;
    this.cache = new Map();
  }

  /**
   * Find the most relevant game for a team: live now, else today's, else the
   * team's next scheduled game.
   * @param {string} query e.g. "arsenal", "the lakers game", "man city premier league"
   * @param {AbortSignal} [signal]
   * @returns {Promise<object|null>}
   */
  async findGame(query, signal) {
    const { team, leagueKeys } = this.parseQuery(query);
    if (!team) return null;

    const boards = await Promise.all(
      leagueKeys.map((key) =>
        this._scoreboard(key, signal).catch((err) => {
          log.debug(`Scoreboard ${key} failed: ${err.message}`);
          return [];
        }),
      ),
    );

    const candidates = boards.flat().filter((g) => matchScore(team, g.home) >= 1 || matchScore(team, g.away) >= 1);
    if (candidates.length) return pickBest(candidates);

    // Not playing in the current scoreboard window → next scheduled game.
    for (const key of leagueKeys) {
      const teamInfo = await this._findTeam(key, team, signal).catch(() => null);
      if (!teamInfo) continue;
      const res = await this._get(`${BASE}/${LEAGUES[key].path}/teams/${teamInfo.id}`, signal);
      const next = res.team?.nextEvent?.[0];
      if (next) return normalizeEvent(next, key);
    }
    return null;
  }

  /**
   * Fetch the latest state of a known game (used for live refresh).
   * @param {string} leagueKey
   * @param {string} eventId
   * @param {AbortSignal} [signal]
   */
  async getGame(leagueKey, eventId, signal) {
    const res = await this._get(`${BASE}/${LEAGUES[leagueKey].path}/summary?event=${encodeURIComponent(eventId)}`, signal);
    const comp = res.header?.competitions?.[0];
    if (!comp) throw new Error("Game not found.");
    return normalizeCompetition(eventId, comp, leagueKey);
  }

  /**
   * Split a spoken query into a team name and the leagues to search.
   * @param {string} query
   */
  parseQuery(query) {
    let text = normalize(query);
    const named = [];
    for (const [key, league] of Object.entries(LEAGUES)) {
      for (const alias of league.aliases) {
        const re = new RegExp(`\\b${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g");
        if (re.test(text)) {
          if (!named.includes(key)) named.push(key);
          text = text.replace(re, " ");
        }
      }
    }
    const team = text
      .replace(FILLER, " ")
      .replace(/'s\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:of|for|in|on|at|with)\s+/, "");
    return { team, leagueKeys: named.length ? named : this.leagues };
  }

  /**
   * One-sentence spoken summary.
   * @param {object} g normalised game
   */
  describe(g) {
    const h = g.home;
    const a = g.away;
    if (g.state === "pre") {
      const when = new Date(g.date).toLocaleString(this.locale || undefined, {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
      });
      return `${a.short} play ${h.short} ${isToday(g.date) ? "today at " + new Date(g.date).toLocaleTimeString(this.locale || undefined, { hour: "numeric", minute: "2-digit" }) : `on ${when}`}.`;
    }
    const score = `${h.short} ${h.score}, ${a.short} ${a.score}`;
    if (g.state === "post") return `Final score: ${score}.`;
    return `${score}, ${g.detail}.`;
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  async _scoreboard(key, signal) {
    const res = await this._get(`${BASE}/${LEAGUES[key].path}/scoreboard`, signal, SCOREBOARD_CACHE_MS);
    return (res.events ?? []).map((e) => normalizeEvent(e, key));
  }

  async _findTeam(key, team, signal) {
    const res = await this._get(`${BASE}/${LEAGUES[key].path}/teams`, signal, TEAMS_CACHE_MS);
    const teams = (res.sports?.[0]?.leagues?.[0]?.teams ?? []).map((t) => t.team);
    let best = null;
    let bestScore = 0;
    for (const t of teams) {
      const s = matchScore(team, { name: t.displayName, short: t.shortDisplayName, abbr: t.abbreviation, nickname: t.name, location: t.location });
      if (s > bestScore) {
        best = t;
        bestScore = s;
      }
    }
    return bestScore >= 1 ? best : null;
  }

  async _get(url, signal, cacheMs = 0) {
    const cached = this.cache.get(url);
    if (cacheMs && cached && Date.now() - cached.at < cacheMs) return cached.data;

    const timeout = AbortSignal.timeout(8000);
    const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
    if (!res.ok) throw new Error(`Sports feed returned HTTP ${res.status}`);
    const data = await res.json();
    if (cacheMs) this.cache.set(url, { at: Date.now(), data });
    return data;
  }
}

// ─── Normalisation helpers ───────────────────────────────────────────────

function normalizeEvent(event, leagueKey) {
  return normalizeCompetition(event.id, { ...event.competitions?.[0], date: event.date ?? event.competitions?.[0]?.date, status: event.status ?? event.competitions?.[0]?.status }, leagueKey);
}

function normalizeCompetition(id, comp, leagueKey) {
  const status = comp.status ?? {};
  const competitors = comp.competitors ?? [];
  const side = (where) => {
    const c = competitors.find((x) => x.homeAway === where) ?? {};
    const t = c.team ?? {};
    return {
      name: t.displayName ?? t.name ?? "",
      short: t.shortDisplayName ?? t.name ?? t.displayName ?? "",
      abbr: t.abbreviation ?? "",
      nickname: t.name ?? "",
      location: t.location ?? "",
      logo: t.logo ?? t.logos?.[0]?.href ?? "",
      score: scoreValue(c.score),
      winner: Boolean(c.winner),
    };
  };

  return {
    id: String(id),
    league: { key: leagueKey, name: LEAGUES[leagueKey]?.name ?? "" },
    state: status.type?.state ?? "pre",
    detail: status.type?.shortDetail ?? status.type?.detail ?? "",
    clock: status.displayClock ?? "",
    period: status.period ?? 0,
    date: comp.date ?? null,
    home: side("home"),
    away: side("away"),
  };
}

function scoreValue(score) {
  if (score === null || score === undefined) return "";
  if (typeof score === "object") return String(score.displayValue ?? score.value ?? "");
  return String(score);
}

/**
 * How well a spoken team name matches a team: 2 = exact name/abbr, 1 = all
 * words found, 0 = no match.
 */
function matchScore(query, team) {
  const names = [team.name, team.short, team.nickname, team.location].map(normalize).filter(Boolean);
  if (names.includes(query) || normalize(team.abbr) === query) return 2;
  const words = query.split(" ").filter(Boolean);
  if (words.length === 0) return 0;
  const hay = ` ${names.join(" ")} `;
  return words.every((w) => hay.includes(` ${w} `) || (w.length >= 4 && hay.includes(` ${w}`))) ? 1 : 0;
}

function pickBest(games) {
  const rank = { in: 0, pre: 1, post: 2 };
  return [...games].sort((a, b) => {
    if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
    const ta = Date.parse(a.date ?? 0);
    const tb = Date.parse(b.date ?? 0);
    return a.state === "post" ? tb - ta : ta - tb;
  })[0];
}

function isToday(date) {
  const d = new Date(date);
  const now = new Date();
  return d.toDateString() === now.toDateString();
}

Sports.LEAGUES = LEAGUES;
Sports.matchScore = matchScore;
Sports.normalizeEvent = normalizeEvent;
module.exports = Sports;
