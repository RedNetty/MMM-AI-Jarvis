"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Replies pick among phrasings at random; tests always get the first one.
require("../lib/speech/talk").random = () => 0;
const Http = require("../lib/data/http");
const Knowledge = require("../lib/data/Knowledge");
const News = require("../lib/data/News");
const Markets = require("../lib/data/Markets");
const Currency = require("../lib/data/Currency");
const Dictionary = require("../lib/data/Dictionary");
const Calculator = require("../lib/data/Calculator");
const InfoSkills = require("../lib/InfoSkills");
const Proactive = require("../lib/Proactive");
const Widgets = require("../lib/Widgets");
const Clock = require("../lib/Clock");
const { detectIntent } = require("../lib/intents");
const { splitSentences } = require("../lib/text");

/** An Http whose fetch answers from a table of URL substrings → bodies. */
function fakeHttp(routes) {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const hit = Object.entries(routes).find(([part]) => url.includes(part));
    if (!hit) return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
    const body = typeof hit[1] === "function" ? hit[1](url) : hit[1];
    if (body && body.status) return { ok: false, status: body.status, json: async () => ({}), text: async () => "" };
    return { ok: true, status: 200, json: async () => body, text: async () => String(body) };
  };
  const http = new Http({ fetch });
  http.calls = calls;
  return http;
}

test("calculator: arithmetic, percentages, tips and unit conversions, offline", () => {
  const a = (q) => Calculator.answer(q)?.spoken ?? null;
  assert.equal(a("what is 15% of 80"), "15 percent of 80 is 12.");
  assert.equal(a("whats 12 times 7"), "12 times 7 is 84.");
  assert.equal(a("what is 7 plus 8 times 2"), "7 plus 8 times 2 is 23.", "operator precedence");
  assert.equal(a("calculate (3 + 4) * 2"), "(3 plus 4) times 2 is 14.");
  assert.equal(a("what is the square root of 144"), "The square root of 144 is 12.");
  assert.equal(a("what is twelve squared"), "12 squared is 144.");
  assert.equal(a("2 to the power of 10"), "2 to the power of 10 is 1,024.");
  assert.equal(a("whats a 20% tip on $85"), "A 20% tip on $85 is $17, so $102 in total.");
  assert.equal(a("convert 5 miles to km"), "5 miles is 8.05 kilometers.");
  assert.equal(a("how many cups in a liter"), "1 liter is 4.23 cups.");
  assert.equal(a("70 fahrenheit in celsius"), "70 degrees Fahrenheit is 21.1 degrees Celsius.");
  assert.equal(a("what is 180 cm in feet"), "180 centimeters is 5 feet 11 inches.");
  assert.equal(a("100 km/h in mph"), "100 kilometers per hour is 62.14 miles per hour.");
  assert.equal(a("how many seconds in a day"), "1 day is 86,400 seconds.");
  assert.equal(a("what is 5 divided by 0"), "That doesn't have an answer. Dividing by zero, maybe?");
  // Not maths: left alone.
  for (const q of ["what is the meaning of life", "what time is it", "tell me a joke", "convert 100 dollars to euros"]) assert.equal(a(q), null, q);
  assert.throws(() => new Calculator.Parser("2+").parse());
});

test("sentences split at full stops, never inside numbers", () => {
  assert.deepEqual(splitSentences("Stocks are up. The S&P 500 is up 0.3%, the Dow up 1.0%. It costs $4.99!", 30, true), [
    "Stocks are up.",
    "The S&P 500 is up 0.3%, the Dow up 1.0%.",
    "It costs $4.99!",
  ]);
});

test("knowledge: Wikipedia search then summary, skipping disambiguation pages", async () => {
  const http = fakeHttp({
    "search/page": { pages: [{ key: "Mercury" }, { key: "Freddie_Mercury" }] },
    "summary/Mercury": { type: "disambiguation", extract: "Mercury may refer to:" },
    "summary/Freddie_Mercury": {
      type: "standard",
      title: "Freddie Mercury",
      description: "British singer (1946–1991)",
      extract: "Freddie Mercury (born Farrokh Bulsara; 5 September 1946 – 24 November 1991) was a British singer and songwriter. He was the lead vocalist of Queen. He is regarded as one of the greatest singers.",
      thumbnail: { source: "https://upload.wikimedia.org/fm.jpg" },
    },
  });
  const k = new Knowledge({ http });
  const page = await k.lookup("who was Freddie Mercury?");
  assert.equal(page.title, "Freddie Mercury");
  assert.equal(page.image, "https://upload.wikimedia.org/fm.jpg");
  assert.match(http.calls[0], /q=Freddie%20Mercury&/, "question words are stripped from the search");
  assert.equal(Knowledge.spoken(page.extract, 2), "Freddie Mercury was a British singer and songwriter. He was the lead vocalist of Queen.");
  assert.equal(Knowledge.topic("Can you tell me about the Eiffel Tower?"), "the Eiffel Tower");
});

test("news: Google News RSS parsing, topics and searches", async () => {
  const rss = `<rss><channel>
    <item><title>Rocket lands safely - Space News</title><link>https://n/1</link><pubDate>Tue, 20 Oct 2026 22:00:00 GMT</pubDate><source url="x">Space News</source></item>
    <item><title><![CDATA[Markets rally &amp; close higher - Reuters]]></title><link>https://n/2</link><pubDate>Tue, 20 Oct 2026 21:00:00 GMT</pubDate></item>
    <item><title>Rocket lands safely - Other Site</title><link>https://n/3</link></item>
  </channel></rss>`;
  const items = News.parseRss(rss);
  assert.deepEqual(items.map((i) => [i.title, i.source]), [
    ["Rocket lands safely", "Space News"],
    ["Markets rally & close higher", "Reuters"],
    ["Rocket lands safely", "Other Site"],
  ]);

  assert.deepEqual(News.parse("what's the news"), {});
  assert.deepEqual(News.parse("tech news please"), { topic: "technology" });
  assert.deepEqual(News.parse("what's the latest on SpaceX"), { query: "spacex" });
  assert.deepEqual(News.parse("any news about the world series"), { query: "world series" });

  const http = fakeHttp({ "news.google.com": rss });
  const result = await new News({ http, locale: "en-GB" }).headlines({ topic: "science" });
  assert.equal(result.title, "Science news");
  assert.equal(result.items.length, 2, "duplicate stories are merged");
  assert.match(http.calls[0], /topic\/SCIENCE\?hl=en-GB&gl=GB&ceid=GB%3Aen/);
});

test("markets: symbols from names, quotes with a change and a series, spoken naturally", async () => {
  const chart = (symbol, price, prev, type = "EQUITY") => ({
    chart: { result: [{ meta: { symbol, shortName: `${symbol} Inc.`, currency: "USD", instrumentType: type, regularMarketPrice: price, chartPreviousClose: prev }, timestamp: [1, 2, 3], indicators: { quote: [{ close: [prev, (prev + price) / 2, price] }] } }] },
  });
  const http = fakeHttp({
    "finance/search": { quotes: [{ symbol: "AAPL", quoteType: "EQUITY" }] },
    "chart/AAPL": chart("AAPL", 101, 100),
    "chart/%5EGSPC": chart("^GSPC", 5050, 5000, "INDEX"),
    "chart/%5EDJI": chart("^DJI", 39000, 39100, "INDEX"),
    "chart/%5EIXIC": chart("^IXIC", 16000, 16000, "INDEX"),
  });
  const m = new Markets({ http });
  assert.deepEqual(await m.resolve("apple stock"), ["AAPL"]);
  assert.deepEqual(await m.resolve("bitcoin"), ["BTC-USD"]);
  assert.deepEqual(await m.resolve("how's the stock market"), Markets.INDICES);

  const q = await m.quote("AAPL");
  assert.equal(q.name, "AAPL");
  assert.equal(Math.round(q.changePercent * 10) / 10, 1);
  assert.equal(q.series.length, 3);
  assert.match(Markets.describe(q), /^AAPL is at \$101\.00.*up 1\.0%/);

  const indices = await Promise.all(Markets.INDICES.map((s) => m.quote(s)));
  assert.equal(Markets.describeMarket(indices), "It's a mixed day. The S&P 500 is up 1.0%, the Dow down 0.3% and the Nasdaq is flat.");
});

test("currency and definitions", async () => {
  const c = new Currency({ http: fakeHttp({ "frankfurter": { base: "USD", date: "2026-10-20", rates: { EUR: 0.9 } } }) });
  assert.deepEqual(c.parse("convert 100 dollars to euros"), { amount: 100, from: "USD", to: "EUR" });
  assert.deepEqual(c.parse("how much is 50 pounds in dollars"), { amount: 50, from: "GBP", to: "USD" });
  assert.deepEqual(c.parse("whats the euro exchange rate"), { amount: 1, from: "EUR", to: "USD" });
  assert.equal(c.parse("convert 5 miles to km"), null);
  assert.equal(Currency.describe(await c.convert({ amount: 100, from: "USD", to: "EUR" })), "$100 is about €90.");

  assert.equal(Dictionary.word("define serendipity"), "serendipity");
  assert.equal(Dictionary.word("what does ephemeral mean?"), "ephemeral");
  assert.equal(Dictionary.word("what is the meaning of ubiquitous"), "ubiquitous");
  // The first source fails; Wiktionary answers.
  const d = new Dictionary({
    http: fakeHttp({
      dictionaryapi: { status: 530 },
      wiktionary: { en: [{ partOfSpeech: "Adjective", definitions: [{ definition: "Lasting a <b>very</b> short time." }] }] },
    }),
  });
  assert.equal(Dictionary.describe(await d.define("ephemeral")), "Ephemeral, an adjective: Lasting a very short time.");
});

test("intents: data questions are routed to data, not the language model", () => {
  const name = (q) => detectIntent(q)?.name ?? null;
  const cases = {
    "good morning": "briefing",
    "brief me": "briefing",
    "when is sunset": "sun_times",
    "what is 17% of 240": "calculate",
    "how many cups in a liter": "calculate",
    "convert 100 dollars to euros": "convert_currency",
    "define serendipity": "define_word",
    "how is the stock market doing": "market_quote",
    "price of bitcoin": "market_quote",
    "what's the news": "news",
    "tech headlines": "news",
    "who is Taylor Swift": "knowledge",
    "tell me about the Eiffel Tower": "knowledge",
    "what's the weather in Paris": "weather_answer",
    "how are the Lakers doing": "show_score",
  };
  for (const [q, intent] of Object.entries(cases)) assert.equal(name(q), intent, q);
  for (const q of ["who are you", "who is winning", "who is the president of France", "hide the news", "what is the capital of Australia"]) {
    assert.ok(!["knowledge", "news"].includes(name(q)), q);
  }
  assert.equal(InfoSkills.placeIn("what's the weather in Paris?"), "Paris");
  assert.equal(InfoSkills.placeIn("is it raining in New York right now"), "New York");
  assert.equal(InfoSkills.placeIn("what's the weather like in the morning"), null);
  assert.equal(InfoSkills.homeCurrency("en-GB"), "GBP");
  assert.equal(InfoSkills.homeCurrency("de-DE"), "EUR");
});

test("info skills show a card for every answer", async () => {
  const widgets = new Widgets({ max: 8 });
  const config = { locale: "en-US", display: { cardTimeout: 60000, infoTimeout: 60000 } };
  const info = new InfoSkills({ widgets, weather: {}, clock: new Clock({ locale: "en-US" }), sports: null, config, now: () => new Date(2026, 9, 21, 18, 46), http: fakeHttp({}) });
  const card = () => widgets.toPublic()[0];

  assert.equal(info.calculate("what is 17% of 240").spoken, "17 percent of 240 is 40.8.");
  assert.deepEqual(card().data, { label: "Answer", display: "40.8", value: 40.800000000000004, caption: "17% of 240" });

  assert.match(info.timeAnswer("what time is it in Tokyo").spoken, /^In Tokyo it's/);
  assert.equal(card().type, "clock");
  assert.equal(card().data.zone, "Asia/Tokyo");

  info.timeAnswer("how long until Christmas");
  assert.equal(card().type, "countdown");
  assert.equal(card().data.days, 65);

  assert.deepEqual(info.calculate("tell me a joke"), { passThrough: true });
  widgets.stop();
});

test("proactive: one morning briefing when someone shows up, rain alerts, quiet hours", async () => {
  let now = new Date(2026, 9, 21, 7, 30);
  const said = [];
  let busy = false;
  const weather = {
    hours: [
      { time: new Date(2026, 9, 21, 8, 0).toISOString(), precipChance: 80, condition: "light rain", temperature: 12 },
    ],
    current: { condition: "overcast" },
  };
  const skills = {
    briefing: async () => ({ spoken: "Good morning, Sam. It's 12° and cloudy." }),
    weather: { get: async () => weather },
    info: { showWeather: () => {} },
    sports: null,
  };
  const p = new Proactive({ config: { proactive: { quietHours: [22, 7] } }, skills, notify: async (text, o) => said.push([text, o.speak]), isBusy: () => busy, now: () => now });

  p.notePresence("voice");
  await new Promise((r) => setTimeout(r, 3100));
  assert.deepEqual(said, [["Good morning, Sam. It's 12° and cloudy.", true]]);
  p.notePresence("voice");
  await new Promise((r) => setTimeout(r, 3100));
  assert.equal(said.length, 1, "once a day");

  await p.checkRain();
  assert.deepEqual(said[1], ["Heads up: rain is likely in about 30 minutes. You might want an umbrella.", true]);
  await p.checkRain();
  assert.equal(said.length, 2, "not repeated within three hours");

  // Next day, but they came to ask something: no briefing on top of it.
  now = new Date(2026, 9, 22, 8, 0);
  p.notePresence("query");
  assert.equal(p._briefingDue(), false);

  // Quiet hours: shown, not spoken.
  now = new Date(2026, 9, 22, 23, 0);
  p.lastRainAlert = 0;
  weather.hours[0].time = new Date(2026, 9, 22, 23, 45).toISOString();
  await p.checkRain();
  assert.equal(said.at(-1)[1], false);
  p.stop();
});
