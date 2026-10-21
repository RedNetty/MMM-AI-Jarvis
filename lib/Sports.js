"use strict";

const Talk = require("./speech/talk");
const { normalize } = require("./text");
const log = require("./log");

const BASE = "https://site.api.espn.com/apis/site/v2/sports";
const SCOREBOARD_CACHE_MS = 20 * 1000;
const TEAMS_CACHE_MS = 24 * 60 * 60 * 1000;

/**
 * Leagues the assistant knows about. `aliases` are words people use when
 * asking ("premier league", "prem", "hockey"); they are matched and stripped
 * from the team query. `period`/`periodMinutes` describe the game clock for
 * speech, `the` says whether team names take "the" ("the Lakers", but
 * "Arsenal"), and `spoken` is how the league is named after "in" (default
 * "the <name>": "in the NBA", but "in MLS").
 */
const LEAGUES = {
  nfl: { path: "football/nfl", name: "NFL", aliases: ["nfl", "football"], period: "quarter", periodMinutes: 15, the: true },
  ncaaf: { path: "football/college-football", name: "College Football", spoken: "college football", aliases: ["college football", "ncaa football", "ncaaf"], period: "quarter", periodMinutes: 15 },
  nba: { path: "basketball/nba", name: "NBA", aliases: ["nba", "basketball"], period: "quarter", periodMinutes: 12, the: true },
  wnba: { path: "basketball/wnba", name: "WNBA", aliases: ["wnba"], period: "quarter", periodMinutes: 10, the: true },
  ncaab: { path: "basketball/mens-college-basketball", name: "College Basketball", spoken: "college basketball", aliases: ["college basketball", "ncaab", "march madness"], period: "half", periodMinutes: 20 },
  mlb: { path: "baseball/mlb", name: "MLB", spoken: "MLB", aliases: ["mlb", "baseball"], period: "inning", the: true },
  nhl: { path: "hockey/nhl", name: "NHL", aliases: ["nhl", "hockey"], period: "period", periodMinutes: 20, the: true },
  epl: { path: "soccer/eng.1", name: "Premier League", aliases: ["premier league", "epl", "prem"], soccer: true },
  championship: { path: "soccer/eng.2", name: "Championship", aliases: ["championship", "efl"], soccer: true },
  laliga: { path: "soccer/esp.1", name: "LaLiga", spoken: "LaLiga", aliases: ["la liga", "laliga"], soccer: true },
  bundesliga: { path: "soccer/ger.1", name: "Bundesliga", aliases: ["bundesliga"], soccer: true },
  seriea: { path: "soccer/ita.1", name: "Serie A", spoken: "Serie A", aliases: ["serie a"], soccer: true },
  ligue1: { path: "soccer/fra.1", name: "Ligue 1", spoken: "Ligue 1", aliases: ["ligue 1", "ligue un"], soccer: true },
  mls: { path: "soccer/usa.1", name: "MLS", spoken: "MLS", aliases: ["mls", "major league soccer"], soccer: true },
  ucl: { path: "soccer/uefa.champions", name: "Champions League", aliases: ["champions league", "ucl"], soccer: true },
  uel: { path: "soccer/uefa.europa", name: "Europa League", aliases: ["europa league", "uel"], soccer: true },
};

const FILLER = /\b(the|game|games|match|matches|score|scores|result|results|latest|live|today|tonight|now|current|currently|right|please|playing|play|team|fc|vs|versus|against|and|how|are|is|was|did|do|doing|what|whats|what s|show|me|tell|check|get|update|any|on|going|happening|sports?)\b/g;
const SOCCER_WORDS = /\b(soccer|footy)\b/;

/**
 * Live sports from ESPN's public JSON feeds (no API key needed).
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

    const boards = await this._boards(leagueKeys, signal);
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
   * Everything on the scoreboards right now across leagues: live games,
   * games still to come today, and today's finals.
   * @param {string[]} [leagueKeys] Defaults to the configured leagues.
   * @param {AbortSignal} [signal]
   * @returns {Promise<{ live: object[], upcoming: object[], finished: object[] }>}
   */
  async overview(leagueKeys = this.leagues, signal) {
    const games = (await this._boards(leagueKeys, signal)).flat();
    const now = Date.now();
    const byTime = (a, b) => Date.parse(a.date ?? 0) - Date.parse(b.date ?? 0);
    const today = (g) => Talk.calendarDays(new Date(g.date), new Date(now)) === 0;
    return {
      live: games.filter((g) => g.state === "in").sort(byTime),
      upcoming: games.filter((g) => g.state === "pre" && Date.parse(g.date) > now - 30 * 60 * 1000).sort(byTime),
      finished: games.filter((g) => g.state === "post" && today(g)).sort((a, b) => byTime(b, a)),
    };
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
   * @returns {{ team: string, leagueKeys: string[], named: boolean }}
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
    if (SOCCER_WORDS.test(text)) {
      for (const key of this.leagues.filter((k) => LEAGUES[k].soccer)) if (!named.includes(key)) named.push(key);
      text = text.replace(SOCCER_WORDS, " ");
    }
    const team = text
      .replace(FILLER, " ")
      .replace(/'s\b/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/^(?:of|for|in|on|at|with)\s+/, "")
      .replace(/\s+(?:of|for|in|on|at|with)$/, "")
      .trim();
    return { team, leagueKeys: named.length ? named : this.leagues, named: named.length > 0 };
  }

  /**
   * One natural spoken sentence about a game.
   *   pre:  "The Lakers play the Warriors tonight at 7."
   *   in:   "The Knicks lead the 76ers 98-91 with 2:31 left in the 4th quarter."
   *   post: "The Celtics beat the Pistons 112-104."
   * @param {object} g normalised game
   * @param {{ now?: Date }} [options]
   */
  describe(g, { now = new Date() } = {}) {
    const home = teamName(g, "home");
    const away = teamName(g, "away");
    const opts = { now, locale: this.locale };

    if (g.state === "pre") {
      const untilStart = Date.parse(g.date) - now.getTime();
      if (untilStart > -30 * 60 * 1000 && untilStart < 10 * 60 * 1000) return cap(`${away} and ${home} are about to get started.`);
      const when = g.date ? Talk.when(g.date, opts) : "soon";
      return cap(`${away} play ${home} ${when}.`);
    }

    const h = Number(g.home.score);
    const a = Number(g.away.score);
    const soccer = LEAGUES[g.league?.key]?.soccer;
    const [leader, trailer, hi, lo] = h >= a ? [home, away, h, a] : [away, home, a, h];
    const score = `${hi}-${lo}`;

    if (g.state === "post") {
      const day = Talk.calendarDays(new Date(g.date ?? now), now);
      const when = day === 0 ? "" : day === -1 ? " yesterday" : ` on ${Talk.weekday(new Date(g.date), this.locale)}`;
      if (h === a) return cap(`${home} and ${away} ${soccer ? "drew" : "tied"} ${score}${when}.`);
      return cap(`${leader} beat ${trailer} ${score}${when}${/OT|SO|overtime|shootout/i.test(g.detail) ? " in overtime" : ""}.`);
    }

    const phase = gamePhase(g);
    if (h === a) {
      if (h === 0) return cap(`${home} and ${away} are still ${soccer ? "goalless" : "scoreless"}${phase ? ` ${phase}` : ""}.`);
      return cap(`${home} and ${away} are ${soccer ? "level" : "tied"} at ${h}${phase ? ` ${phase}` : ""}.`);
    }
    return cap(`${leader} lead ${trailer} ${score}${phase ? ` ${phase}` : ""}.`);
  }

  /**
   * Spoken summary of overview(): how many games are on and the first few
   * scores, or what's next when nothing is live.
   * @param {{ live: object[], upcoming: object[], finished: object[] }} board
   * @param {{ leagueKeys?: string[], now?: Date }} [options] leagueKeys: leagues the user named.
   */
  describeOverview(board, { leagueKeys = [], now = new Date() } = {}) {
    const names = leagueKeys.map((k) => LEAGUES[k]?.spoken ?? `the ${LEAGUES[k]?.name}`);
    const where = names.length && names.length <= 3 ? ` in ${Talk.list(names)}` : "";
    const sentences = [];
    if (board.live.length) {
      const n = board.live.length;
      sentences.push(n === 1 ? `There's one game on right now${where}.` : `There are ${Talk.count(n)} games on right now${where}.`);
      for (const g of board.live.slice(0, 2)) sentences.push(this.describe(g, { now }));
      if (n > 2) sentences.push("The rest are on the mirror.");
      return sentences.join(" ");
    }
    sentences.push(Talk.pick([`Nothing's live right now${where}.`, `No games on right now${where}.`]));
    const next = board.upcoming[0];
    const lower = (text) => text.replace(/^The /, "the ");
    if (next) sentences.push(`Next up, ${lower(this.describe(next, { now }))}`);
    else if (board.finished[0]) sentences.push(`Earlier today, ${lower(this.describe(board.finished[0], { now }))}`);
    return sentences.join(" ");
  }

  // ─── Internals ─────────────────────────────────────────────────────────

  _boards(leagueKeys, signal) {
    return Promise.all(
      leagueKeys.map((key) =>
        this._scoreboard(key, signal).catch((err) => {
          log.debug(`Scoreboard ${key} failed: ${err.message}`);
          return [];
        }),
      ),
    );
  }

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

// ─── Speech helpers ──────────────────────────────────────────────────────

/** "the Lakers" for US pro leagues, "Arsenal" for clubs. */
function teamName(g, side) {
  const t = g[side];
  const name = t.short || t.name || t.abbr || (side === "home" ? "the home side" : "the visitors");
  return LEAGUES[g.league?.key]?.the && !/^the /i.test(name) ? `the ${name}` : name;
}

/**
 * Where a live game is, as words: "in the 67th minute", "at halftime",
 * "with 2:31 left in the 4th quarter", "in the top of the 7th".
 * @param {object} g
 */
function gamePhase(g) {
  const d = String(g.detail ?? "").trim();
  const league = LEAGUES[g.league?.key] ?? {};
  const periodWord = league.period ?? "";
  let m;
  if ((m = /^(\d{1,3})'\s*\+\s*\d+'?$/.exec(d))) return Number(m[1]) >= 90 ? "in stoppage time" : "in first-half stoppage time";
  if ((m = /^(\d{1,3})'$/.exec(d))) return `in the ${Talk.ordinal(Number(m[1]))} minute`;
  if (/^(HT|Half ?time)$/i.test(d)) return "at halftime";
  if ((m = /^(\d+):(\d{2}) - (\d)(?:st|nd|rd|th)$/.exec(d))) {
    if (Number(m[1]) === league.periodMinutes && Number(m[2]) === 0) return `at the start of the ${Talk.ordinal(Number(m[3]))} ${periodWord}`;
    const clock = Number(m[1]) === 0 ? `${Number(m[2])} seconds` : `${m[1]}:${m[2]}`;
    return `with ${clock} left in the ${Talk.ordinal(Number(m[3]))}${periodWord && periodWord !== "inning" ? ` ${periodWord}` : ""}`;
  }
  if ((m = /^(\d+(?:\.\d+)?) - (\d)(?:st|nd|rd|th)$/.exec(d))) {
    const secs = Math.ceil(Number(m[1]));
    return `with ${secs} second${secs === 1 ? "" : "s"} left in the ${Talk.ordinal(Number(m[2]))}${periodWord ? ` ${periodWord}` : ""}`;
  }
  if ((m = /^End of (\d)(?:st|nd|rd|th)$/i.exec(d))) return `at the end of the ${Talk.ordinal(Number(m[1]))}${periodWord && periodWord !== "inning" ? ` ${periodWord}` : ""}`;
  if ((m = /^(Top|Bot|Bottom|Mid|Middle|End) (\d+)(?:st|nd|rd|th)$/i.exec(d))) {
    const part = { top: "top", bot: "bottom", bottom: "bottom", mid: "middle", middle: "middle", end: "end" }[m[1].toLowerCase()];
    return `in the ${part} of the ${Talk.ordinal(Number(m[2]))}`;
  }
  if (/^(OT|SO|\d?OT)$/i.test(d)) return "in overtime";
  return d ? `(${d})` : "";
}

function cap(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
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

Sports.LEAGUES = LEAGUES;
Sports.matchScore = matchScore;
Sports.normalizeEvent = normalizeEvent;
Sports.gamePhase = gamePhase;
module.exports = Sports;
