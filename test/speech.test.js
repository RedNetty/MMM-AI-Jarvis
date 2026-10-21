"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("http");

// Replies pick among phrasings at random; tests always get the first one.
const Talk = require("../lib/speech/talk");
Talk.random = () => 0;
const { verbalize, numberWords, ordinalWord, clockWords } = require("../lib/speech/verbalize");
const WeatherTalk = require("../lib/speech/weatherTalk");
const Weather = require("../lib/Weather");
const Clock = require("../lib/Clock");
const Sports = require("../lib/Sports");
const VoiceActivityDetector = require("../lib/audio/VoiceActivityDetector");
const KokoroTTS = require("../lib/tts/KokoroTTS");
const ChainTTS = require("../lib/tts/ChainTTS");
const { createTTS } = require("../lib/tts");
const { detectIntent } = require("../lib/intents");

// Wednesday, October 21, 2026, 6:46 PM local time.
const NOW = new Date(2026, 9, 21, 18, 46);

test("verbalize: times, game clocks, dates and units read the way people say them", () => {
  const cases = {
    "Celtics play Pistons today at 7:00 PM.": "Celtics play Pistons today at seven p.m.",
    "It's 6:46.": "It's six forty-six.",
    "Doors at 9:05 am": "Doors at nine oh five a.m.",
    "The train leaves at 18:30.": "The train leaves at six thirty p.m.",
    "Lakers 102, Celtics 98, Q4 2:31.": "Lakers 102, Celtics 98, two thirty-one left in the fourth quarter.",
    "Arsenal 2, Everton 1, 67'.": "Arsenal 2, Everton 1, 67th minute.",
    "Bayern lead PSG 1-0 at HT.": "Bayern lead PSG 1 to 0 at half time.",
    "Yankees 3, Red Sox 2, Bot 7th.": "Yankees 3, Red Sox 2, bottom of the seventh.",
    "It's 6:46 PM on Wed, Oct 21.": "It's six forty-six p.m. on Wednesday, October 21st.",
    "The meeting is on 10/24.": "The meeting is on October 24th.",
    "Due 2026-11-03.": "Due November 3rd, 2026.",
    "High 58°F, 70% chance of rain, wind 14 mph.": "High 58 degrees, 70 percent chance of rain, wind 14 miles per hour.",
    "Right now it's -3°C with wind at 20 km/h.": "Right now it's minus 3 degrees with wind at 20 kilometers per hour.",
    "Tonight looks clear, between 56° and 65°.": "Tonight looks clear, between 56 degrees and 65 degrees.",
    "It's 1° Celsius": "It's 1 degree Celsius",
    "Lakers vs Celtics & more": "Lakers versus Celtics and more",
    "It's $5.99": "It's 5 dollars 99 cents",
  };
  for (const [input, expected] of Object.entries(cases)) assert.equal(verbalize(input), expected, input);
  // Outside the US, 3/4 is the 3rd of April.
  assert.equal(verbalize("On 3/4", { locale: "en-GB" }), "On April 3rd");
  // Words that look like weekday abbreviations stay as they are.
  assert.equal(verbalize("Sun is out, sat outside"), "Sun is out, sat outside");

  assert.equal(numberWords(46), "forty-six");
  assert.equal(ordinalWord(21), "twenty-first");
  assert.equal(ordinalWord(4), "fourth");
  assert.equal(clockWords(0, 0), "midnight");
  assert.equal(clockWords(12, 0), "noon");
});

test("talk: relative days, natural durations and times", () => {
  const at = (d, h, m = 0) => new Date(2026, 9, 21 + d, h, m);
  assert.equal(Talk.when(at(0, 19), { now: NOW }), "in 14 minutes");
  assert.equal(Talk.when(at(0, 21, 30), { now: NOW }), "tonight at 9:30");
  assert.equal(Talk.when(at(1, 13), { now: NOW }), "tomorrow at 1 PM");
  assert.equal(Talk.when(at(1, 2), { now: NOW }), "late tonight at 2 AM");
  assert.equal(Talk.when(at(3, 15), { now: NOW }), "Saturday at 3 PM");
  assert.equal(Talk.when(at(12, 20), { now: NOW }), "on November 2nd at 8 PM");
  assert.equal(Talk.relativeDay(at(1, 8), { now: NOW }), "tomorrow morning");
  assert.equal(Talk.relativeDay(at(0, 20), { now: NOW }), "tonight");

  assert.equal(Talk.duration(90 * 60 * 1000), "an hour and a half");
  assert.equal(Talk.duration(25 * 60 * 1000), "25 minutes");
  assert.equal(Talk.duration(2 * 3600e3 + 10 * 60e3), "2 hours and 10 minutes");
  assert.equal(Talk.duration(45 * 1000), "45 seconds");
  assert.equal(Talk.duration(3 * 86400e3), "3 days");

  assert.equal(Talk.timeNow(NOW), "It's 6:46.");
  assert.equal(Talk.timeNow(new Date(2026, 9, 21, 19, 0)), "It's 7 o'clock.");
  assert.equal(Talk.timeNow(new Date(2026, 9, 21, 18, 59)), "It's just about 7.");
  assert.equal(Talk.timeNow(NOW, { locale: "de-DE" }), "It's 18:46.");
  assert.equal(Talk.dateLong(NOW), "Wednesday, October 21st");
});

test("clock: time questions are answered exactly, without a language model", () => {
  const clock = new Clock({ locale: "en-US", facts: () => ["the user's birthday is March 3rd"] });
  const ask = (q) => clock.answer(q, NOW);

  assert.equal(ask("What time is it?"), "It's 6:46.");
  assert.equal(ask("what's the date"), "It's Wednesday, October 21st.");
  assert.equal(ask("what day is it"), "It's Wednesday.");
  assert.equal(ask("How long until Christmas?"), "Christmas is 65 days away, on Friday, December 25th.");
  assert.equal(ask("how many days until halloween"), "Halloween is 10 days away, on Saturday, October 31st.");
  assert.equal(ask("how long until 9 pm"), "9 PM is 2 hours and 14 minutes away.");
  assert.equal(ask("how long until half past seven"), "7:30 PM is 44 minutes away.");
  assert.equal(ask("how long until friday"), "Friday is in 2 days.");
  assert.equal(ask("how many days until my birthday"), "Your birthday is 133 days away, on Wednesday, March 3rd.");
  assert.equal(ask("when is thanksgiving"), "Thanksgiving is 36 days away, on Thursday, November 26th.");
  assert.equal(ask("what day is the 4th of july"), "The Fourth of July is on a Sunday.");
  assert.equal(ask("what's the date next friday"), "Friday is October 23rd.");
  assert.equal(ask("what date is it in 10 days"), "10 days from now is Saturday, October 31st.");
  assert.equal(ask("what day is tomorrow"), "Tomorrow is Thursday, October 22nd.");
  assert.match(ask("what time is it in Tokyo"), /^In Tokyo it's \d{1,2}:46 (in the morning|in the afternoon|in the evening|at night)(, (already|still) \w+day)?\. That's /);
  assert.equal(ask("what time is it in Narnia"), "I'm not sure which time zone Narnia is in.");

  // Not time questions: left for other skills.
  assert.equal(ask("when is the lakers game"), null);
  assert.equal(ask("tell me a joke"), null);
  assert.equal(ask("set a timer for 10 minutes"), null);

  // Places named in a request get their local time in the language model's context.
  const places = clock.placeTimes("is it too late to call my mom in London? I fly from Paris to Los Angeles", NOW);
  // The mirror's own zone is left out (it's already the bracketed time).
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const expected = ["london", "paris", "los angeles"].filter((p) => Clock.zoneFor(p) !== local);
  assert.equal(places.length, expected.length);
  assert.match(places[0], /^(?:London|Paris|Los Angeles): \d{1,2}(:\d\d)? [AP]M \w+day$/);
  assert.deepEqual(clock.placeTimes("I'm in the mood for pizza", NOW), []);
  assert.equal(Clock.zoneFor("new york"), "America/New_York");
  assert.equal(Clock.zoneFor("the uk"), "Europe/London");
  assert.equal(Clock.zoneFor("mood"), null);

  // Easter moves; the computus gets it right.
  assert.equal(clock.parse("easter", new Date(2026, 0, 1)).date.toDateString(), new Date(2026, 3, 5).toDateString());
  assert.deepEqual(Clock.parseTimeOfDay("quarter to 7"), { hours: 18, minutes: 45 });
  assert.deepEqual(Clock.parseTimeOfDay("9 30 am"), { hours: 9, minutes: 30 });
});

test("weather: natural answers, and hourly windows for tonight and tomorrow morning", async () => {
  const weather = new Weather({ units: "metric" });
  const hourly = [];
  for (let d = 0; d < 2; d++) {
    for (let h = 0; h < 24; h++) {
      const time = new Date(2026, 9, 21 + d, h).getTime();
      const evening = d === 0 && h >= 18;
      hourly.push({ time, temperature: evening ? 12 - (h - 18) : 14, precipitationProbability: evening && h >= 20 ? 70 : 5, weatherType: evening && h >= 20 ? "night-rain" : "day-cloudy" });
    }
  }
  weather.updateFromMirror({
    units: "metric",
    current: { temperature: 15, feelsLike: 11, windSpeed: 3, weatherType: "day-sunny" },
    forecast: [{ maxTemperature: 21, minTemperature: 9, precipitationProbability: 70, weatherType: "day-showers" }],
    hourly,
  });

  const answer = async (q) => new WeatherTalk(await weather.get(Weather.parseWhen(q, NOW), NOW), { now: NOW }).answer(q);
  assert.deepEqual(Weather.parseWhen("what's it like tonight", NOW), { day: 0, from: 18, to: 24, label: "tonight" });
  assert.deepEqual(Weather.parseWhen("weather tomorrow morning", NOW), { day: 1, from: 6, to: 12, label: "tomorrow morning" });
  assert.deepEqual(Weather.parseWhen("weather tomorrow", NOW), { day: 1 });

  assert.equal(await answer("what's the weather?"), "It's 15° and sunny right now, but it feels more like 11°. Down to 7° tonight. Rain is likely tonight, so take an umbrella.");
  assert.equal(await answer("will it rain tonight?"), "Yes, take an umbrella. Rain's likely tonight, about 70%.");
  assert.equal(await answer("what's the weather like tomorrow morning"), "Tomorrow morning looks cloudy, around 14°. It should stay dry.");
  assert.equal(await answer("do I need a jacket?"), "Yes, it's chilly, 11°. A proper jacket's a good idea, ideally a waterproof one.");

  // Never the old data dump.
  assert.doesNotMatch(await answer("what's the weather?"), /Now:|chance of precipitation|km\/h/);
  assert.equal(WeatherTalk.sky("clear sky", { night: true }), "clear");
  assert.equal(WeatherTalk.sky("light rain"), "raining lightly");
});

test("sports: game phases and an overview that never guesses", () => {
  const s = new Sports({ locale: "en-US" });
  const game = (league, detail, state = "in", home = ["Knicks", "100"], away = ["76ers", "106"]) => ({
    id: "1",
    league: { key: league, name: Sports.LEAGUES[league].name },
    state,
    detail,
    date: new Date(NOW.getTime() - 3600e3).toISOString(),
    home: { short: home[0], score: home[1] },
    away: { short: away[0], score: away[1] },
  });
  assert.equal(Sports.gamePhase(game("nba", "7.7 - 4th")), "with 8 seconds left in the 4th quarter");
  assert.equal(Sports.gamePhase(game("nba", "7:55 - 1st")), "with 7:55 left in the 1st quarter");
  assert.equal(Sports.gamePhase(game("nhl", "20:00 - 3rd")), "at the start of the 3rd period");
  assert.equal(Sports.gamePhase(game("nhl", "End of 1st")), "at the end of the 1st period");
  assert.equal(Sports.gamePhase(game("mlb", "Top 7th")), "in the top of the 7th");
  assert.equal(Sports.gamePhase(game("epl", "45'+2'")), "in first-half stoppage time");
  assert.equal(Sports.gamePhase(game("nba", "Halftime")), "at halftime");

  assert.equal(s.describe(game("nba", "2:31 - 4th"), { now: NOW }), "The 76ers lead the Knicks 106-100 with 2:31 left in the 4th quarter.");
  assert.equal(s.describe(game("nhl", "14:41 - 1st", "in", ["Red Wings", "0"], ["Kraken", "0"]), { now: NOW }), "The Red Wings and the Kraken are still scoreless with 14:41 left in the 1st period.");
  assert.equal(s.describe(game("nba", "Final", "post"), { now: NOW }), "The 76ers beat the Knicks 106-100.");

  const live = [game("nba", "2:31 - 4th"), game("nhl", "End of 1st", "in", ["Wild", "1"], ["Oilers", "1"]), game("nba", "Halftime", "in", ["Spurs", "50"], ["Thunder", "48"])];
  assert.equal(
    s.describeOverview({ live, upcoming: [], finished: [] }, { now: NOW }),
    "There are three games on right now. The 76ers lead the Knicks 106-100 with 2:31 left in the 4th quarter. " +
      "The Wild and the Oilers are tied at 1 at the end of the 1st period. The rest are on the mirror.",
  );
  const upcoming = [{ ...game("mlb", "", "pre", ["Brewers", ""], ["Rays", ""]), date: new Date(2026, 9, 22, 20, 0).toISOString() }];
  assert.equal(
    s.describeOverview({ live: [], upcoming, finished: [] }, { leagueKeys: ["mlb"], now: NOW }),
    "Nothing's live right now in MLB. Next up, the Rays play the Brewers tomorrow at 8 PM.",
  );
});

test("intents: time questions and 'what games are on' never reach the language model", () => {
  const name = (q) => detectIntent(q)?.name ?? null;
  assert.equal(name("what sports games are going on right now?"), "sports_overview");
  assert.equal(name("what games are on tonight"), "sports_overview");
  assert.equal(name("any soccer games on"), "sports_overview");
  assert.equal(name("what are the NBA scores"), "sports_overview");
  assert.equal(name("who is playing tonight"), "sports_overview");
  assert.equal(name("what time is it in Tokyo"), "time_answer");
  assert.equal(name("how long until Christmas"), "time_answer");
  assert.equal(name("what day is halloween"), "time_answer");
  assert.equal(name("what time is the lakers game"), "show_score");
  assert.equal(name("when is the next arsenal match"), "show_score");
  assert.equal(name("how long until the timer is done"), "timer_status");
  assert.equal(name("what game should I play tonight"), null);
});

test("voice activity: a short pause offers a speculative transcript; cut() ends the utterance", () => {
  const vad = new VoiceActivityDetector({ threshold: 500, silenceMs: 600, pauseMs: 200, minUtteranceMs: 100, preRollMs: 0, startMs: 20 });
  const frame = (amp) => {
    const b = Buffer.alloc(640);
    for (let i = 0; i < 320; i++) b.writeInt16LE(i % 2 ? amp : -amp, i * 2);
    return b;
  };
  const events = [];
  vad.on("pause", (p) => events.push(`pause:${p.id}`));
  vad.on("resume", (id) => events.push(`resume:${id}`));
  vad.on("utterance", (pcm, meta) => events.push(`utterance:${meta.id}`));
  const feed = (amp, frames) => {
    for (let i = 0; i < frames; i++) vad.write(frame(amp));
  };

  feed(0, 10);
  feed(3000, 20); // 400 ms of speech
  feed(0, 12); // 240 ms pause → speculative transcript
  assert.deepEqual(events, ["pause:1"]);
  feed(3000, 10); // kept talking
  assert.deepEqual(events, ["pause:1", "resume:1"]);
  feed(0, 12);
  assert.ok(vad.cut(1), "cut the utterance once its transcript is accepted");
  feed(0, 40);
  assert.deepEqual(events, ["pause:1", "resume:1", "pause:1"], "a cut utterance is never emitted");

  feed(3000, 20);
  feed(0, 40);
  assert.deepEqual(events.slice(-2), ["pause:2", "utterance:2"]);
  assert.equal(vad.cut(2), false, "nothing to cut between utterances");
});

test("voices: Kokoro first, Piper when the Mac is asleep", async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null });
      if (req.url === "/") return res.end('{"ok":true}');
      res.setHeader("Content-Type", "audio/wav");
      res.end(Buffer.from(`kokoro:${JSON.parse(raw).text}`));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const kokoro = new KokoroTTS({ url, voice: "af_heart", speed: 1.1 });
    const piper = { name: "Piper", synthesize: async (t) => Buffer.from(`piper:${t}`), healthCheck: async () => null };
    const chain = new ChainTTS([kokoro, piper]);
    assert.equal(await chain.healthCheck(), null);
    assert.equal((await chain.synthesize("Hello there.")).toString(), "kokoro:Hello there.");
    assert.deepEqual(requests.at(-1).body, { text: "Hello there.", voice: "af_heart", speed: 1.1 });

    // The Mac goes to sleep: the probe marks it down and Piper speaks without waiting.
    await new Promise((r) => server.close(r));
    await kokoro.pool.probeAll();
    assert.equal(kokoro.available, false);
    assert.equal((await chain.synthesize("Still here.")).toString(), "piper:Still here.");
    assert.equal(await chain.healthCheck(), null, "a working fallback is not a problem");
  } finally {
    server.close();
  }

  const tts = createTTS({ provider: "kokoro", kokoroUrl: "http://127.0.0.1:1", piperUrl: "http://127.0.0.1:2", piperModel: "" });
  assert.match(tts.name, /^Kokoro .* falling back to Piper/);
  assert.throws(() => createTTS({ provider: "nope" }), /Use "kokoro", "piper" or "espeak"/);
});
