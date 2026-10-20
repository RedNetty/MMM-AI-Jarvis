"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Widgets = require("../lib/Widgets");
const Screen = require("../lib/Screen");
const Sports = require("../lib/Sports");
const Skills = require("../lib/Skills");
const Weather = require("../lib/Weather");
const Wardrobe = require("../lib/Wardrobe");
const Memory = require("../lib/Memory");
const { detectIntent, matchCustomCommand, toThirdPerson } = require("../lib/intents");
const { parseDuration, formatDuration } = require("../lib/text");

const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ESPN scoreboard event, trimmed to the fields Jarvis uses.
const EVENT = {
  id: "401",
  date: "2026-10-24T14:00Z",
  status: { displayClock: "67'", period: 2, type: { state: "in", shortDetail: "67'" } },
  competitions: [
    {
      competitors: [
        { homeAway: "home", score: "2", team: { displayName: "Arsenal", shortDisplayName: "Arsenal", abbreviation: "ARS", name: "Arsenal", location: "Arsenal", logo: "https://a/ars.png" } },
        { homeAway: "away", score: "1", team: { displayName: "Everton", shortDisplayName: "Everton", abbreviation: "EVE", name: "Everton", location: "Everton", logo: "https://a/eve.png" } },
      ],
    },
  ],
};

test("Sports: query parsing, team matching and normalisation", () => {
  const s = new Sports();
  assert.deepEqual(s.parseQuery("what's the score of the Arsenal game"), { team: "arsenal", leagueKeys: s.leagues });
  assert.deepEqual(s.parseQuery("man city premier league score"), { team: "man city", leagueKeys: ["epl"] });
  assert.equal(s.parseQuery("how are the broncos doing").team, "broncos");

  const game = Sports.normalizeEvent(EVENT, "epl");
  assert.equal(game.state, "in");
  assert.equal(game.home.score, "2");
  assert.equal(game.league.name, "Premier League");
  assert.equal(s.describe(game), "Arsenal 2, Everton 1, 67'.");
  assert.equal(s.describe({ ...game, state: "post" }), "Final score: Arsenal 2, Everton 1.");

  assert.equal(Sports.matchScore("arsenal", game.home), 2);
  assert.equal(Sports.matchScore("ars", game.home), 2);
  assert.equal(Sports.matchScore("everton", game.home), 0);
  assert.equal(Sports.matchScore("man city", { name: "Manchester City", short: "Man City", abbr: "MNC" }), 2);
  assert.equal(Sports.matchScore("manchester", { name: "Manchester City", short: "Man City", abbr: "MNC" }), 1);
});

test("Sports: scoreboard schedule-endpoint scores are objects", () => {
  const e = structuredClone(EVENT);
  e.competitions[0].competitors[0].score = { value: 3, displayValue: "3" };
  assert.equal(Sports.normalizeEvent(e, "epl").home.score, "3");
});

test("Widgets: dedupe by key, limits, expiry and live refresh", async () => {
  const w = new Widgets({ max: 2 });
  const changes = [];
  const expired = [];
  w.on("change", (list) => changes.push(list));
  w.on("expired", (x) => expired.push(x.type));

  const a = w.add({ type: "score", key: "g1", data: { n: 1 } });
  const b = w.add({ type: "score", key: "g1", data: { n: 2 } });
  assert.equal(a.id, b.id, "same key updates the existing widget");
  assert.equal(w.list().length, 1);

  w.add({ type: "timer", data: {}, ttlMs: 30 });
  w.add({ type: "info", data: {} });
  assert.deepEqual(w.list().map((x) => x.type).sort(), ["info", "timer"], "oldest non-timer evicted");

  await tick(60);
  assert.deepEqual(expired, ["timer"]);
  assert.deepEqual(w.toPublic().map((x) => x.type), ["info"]);

  let calls = 0;
  w.add({
    type: "score",
    key: "live",
    data: { score: 0 },
    firstRefreshMs: 10,
    refresh: async () => {
      calls += 1;
      return calls < 3 ? { data: { score: calls }, nextMs: 10 } : { data: { score: 99 }, nextMs: null };
    },
  });
  await tick(120);
  assert.equal(calls, 3, "refresh stops when nextMs is null");
  assert.equal(w.list("score")[0].data.score, 99);
  assert.ok(changes.length > 5);
  w.stop();
});

test("Screen: module matching and commands", () => {
  const s = new Screen();
  const commands = [];
  s.on("command", (c) => commands.push(c));
  s.setInventory([
    { id: "m1", name: "newsfeed", position: "bottom_bar" },
    { id: "m2", name: "calendar", header: "US Holidays", position: "top_left" },
    { id: "m3", name: "weather", position: "top_right", hidden: true },
    { id: "m4", name: "MMM-AI-Jarvis", position: "bottom_center" },
    { id: "m5", name: "MMM-GoogleMapsTraffic", position: "top_left" },
  ]);
  assert.deepEqual(s.find("the news").map((m) => m.id), ["m1"]);
  assert.deepEqual(s.find("holidays").map((m) => m.id), ["m2"]);
  assert.deepEqual(s.find("traffic").map((m) => m.id), ["m5"]);
  assert.deepEqual(s.find("top left").map((m) => m.id), ["m2", "m5"]);
  assert.deepEqual(s.find("jarvis"), [], "never targets itself");
  assert.deepEqual(s.find("pancakes"), []);

  assert.equal(s.focus(), 3, "focus hides every visible module");
  s.restore();
  assert.deepEqual(commands, [{ action: "hide", ids: ["m1", "m2", "m5"] }, { action: "restore" }]);
});

function buildSkills({ sports = null, screen = new Screen() } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-display-"));
  const widgets = new Widgets({ max: 4 });
  const skills = new Skills({
    ollama: {},
    wardrobe: new Wardrobe(dir),
    memory: new Memory(dir),
    camera: { available: false },
    weather: new Weather(),
    search: null,
    sports,
    widgets,
    screen,
    config: { assistantName: "Jarvis", display: { cardTimeout: 60000, infoTimeout: 60000, snapshotTimeout: 8000 } },
  });
  return { skills, widgets, screen };
}

test("Skills: live scoreboard widget refreshes and lingers after full time", async () => {
  let state = "in";
  const game = Sports.normalizeEvent(EVENT, "epl");
  const fakeSports = {
    findGame: async (team) => (team === "arsenal" ? game : null),
    getGame: async () => ({ ...game, state, home: { ...game.home, score: "3" } }),
    describe: (g) => new Sports().describe(g),
  };
  const { skills, widgets } = buildSkills({ sports: fakeSports });

  assert.equal((await skills.showScore("arsenal")).spoken, "Arsenal 2, Everton 1, 67'.");
  assert.equal((await skills.showScore("nobody")).spoken, "I couldn't find a game for nobody.");
  const w = widgets.list("score")[0];
  assert.equal(w.key, "score:epl:401");
  assert.equal(Skills.scoreRefreshDelay(game), 20000);
  assert.equal(Skills.scoreRefreshDelay({ ...game, state: "post" }), null);
  const future = new Date(Date.now() + 3 * 3600e3).toISOString();
  assert.equal(Skills.scoreRefreshDelay({ ...game, state: "pre", date: future }), 600000);

  state = "post";
  const result = await w.refresh(w);
  assert.equal(result.data.home.score, "3");
  assert.equal(result.nextMs, null);
  assert.equal(result.expireInMs, 20 * 60 * 1000);
  widgets.stop();
});

test("Skills: timers, info panels, and hiding cards vs modules", () => {
  const screen = new Screen();
  const commands = [];
  screen.on("command", (c) => commands.push(c));
  screen.setInventory([{ id: "m1", name: "newsfeed", position: "bottom_bar" }]);
  const { skills, widgets } = buildSkills({ screen });

  assert.equal(skills.setTimer(600, "pasta").spoken, "Pasta timer set for 10 minutes.");
  assert.equal(skills.setTimer(0).spoken, "How long should the timer be?");
  assert.match(skills.timeLeft().spoken, /^(10 minutes|9 minutes 59 seconds) left on the pasta timer\.$/);

  skills.showInfo({ title: "**Pancakes**", lines: ["1. Mix flour", "- Add eggs 🥚", ""] });
  const info = widgets.list("info")[0].data;
  assert.deepEqual(info, { title: "Pancakes", subtitle: "", lines: ["Mix flour", "Add eggs"] });

  assert.equal(skills.hideOnScreen("the panel").spoken, "Done.");
  assert.equal(widgets.list("info").length, 0);
  assert.equal(skills.hideOnScreen("the news").spoken, "Done.");
  assert.deepEqual(commands, [{ action: "hide", ids: ["m1"] }]);
  assert.equal(skills.hideOnScreen("everything").spoken, "There's nothing of mine on the screen.");
  assert.equal(widgets.list("timer").length, 1, "clearing cards keeps running timers");
  assert.equal(skills.cancelTimer("pasta").spoken, "Timer cancelled.");
  assert.equal(skills.cancelTimer().spoken, "There's no timer running.");
  widgets.stop();
});

test("Intents for display, timers and memory", () => {
  const screen = new Screen();
  screen.setInventory([{ id: "m1", name: "calendar", position: "top_left" }]);
  const intent = (q) => detectIntent(q, { screen });

  assert.deepEqual(intent("what's the score of the Arsenal game?"), { name: "show_score", args: { team: "Arsenal" } });
  assert.deepEqual(intent("did the Yankees win"), { name: "show_score", args: { team: "Yankees" } });
  assert.equal(intent("how are you doing"), null);
  assert.deepEqual(intent("set a pasta timer for 12 minutes"), { name: "set_timer", args: { seconds: 720, label: "pasta" } });
  assert.deepEqual(intent("cancel the pasta timer"), { name: "cancel_timer", args: { label: "pasta" } });
  assert.deepEqual(intent("hide the calendar"), { name: "hide_on_mirror", args: { target: "calendar" } });
  assert.deepEqual(intent("close that"), { name: "hide_on_mirror", args: { target: "everything" } });
  assert.deepEqual(intent("show the calendar"), { name: "show_module", args: { target: "calendar" } });
  assert.deepEqual(intent("show me a recipe for pancakes"), { name: "compose_panel", args: { request: "show me a recipe for pancakes" } });
  assert.equal(intent("show the weather"), null, "modules that aren't on this mirror go to the LLM");
  assert.deepEqual(intent("bring back everything"), { name: "show_module", args: { target: "everything" } });
  assert.deepEqual(intent("focus mode"), { name: "focus_mode", args: {} });
  assert.deepEqual(intent("great, I'll wear that"), { name: "log_outfit_worn", args: {} });
  assert.deepEqual(intent("I'm wearing this today"), { name: "log_outfit_worn", args: {} });
  assert.deepEqual(intent("remember that I'm allergic to wool"), { name: "remember", args: { fact: "the user is allergic to wool" } });
  assert.equal(toThirdPerson("my office is business casual"), "the user's office is business casual");

  const commands = [{ phrases: ["next page", "page forward"], notification: "PAGE_INCREMENT" }];
  assert.equal(matchCustomCommand("Next page, please", commands)?.notification, "PAGE_INCREMENT");
  assert.equal(matchCustomCommand("what's on the next pages", commands), null);
});

test("Durations", () => {
  assert.equal(parseDuration("an hour and a half"), 5400);
  assert.equal(parseDuration("1h 30m"), 5400);
  assert.equal(parseDuration("twenty five seconds"), 25);
  assert.equal(parseDuration("half an hour"), 1800);
  assert.equal(parseDuration("a timer"), null);
  assert.equal(formatDuration(3661), "1 hour 1 minute 1 second");
});

test("Weather from MagicMirror 2.38 imperial payload", async () => {
  const metric = new Weather({ units: "metric" });
  metric.updateFromMirror({ units: "imperial", current: { temperature: 50, windSpeed: 10 }, forecast: [{ maxTemperature: 59, minTemperature: 41 }] });
  const w = await metric.get();
  assert.equal(w.current.temperature, 10);
  assert.equal(w.current.wind, 16.1);
  assert.equal(w.day.high, 15);

  const imperial = new Weather({ units: "imperial" });
  imperial.updateFromMirror({ units: "imperial", current: { temperature: 50, windSpeed: 10 } });
  assert.equal((await imperial.get()).current.temperature, 50);
  assert.equal((await imperial.get()).current.wind, 10);
});
