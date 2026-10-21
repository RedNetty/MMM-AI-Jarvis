"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

// Replies pick among phrasings at random; tests always get the first one.
require("../lib/speech/talk").random = () => 0;
const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");

const Ollama = require("../lib/Ollama");
const Wardrobe = require("../lib/Wardrobe");
const Memory = require("../lib/Memory");
const Weather = require("../lib/Weather");
const Skills = require("../lib/Skills");
const Assistant = require("../lib/Assistant");
const Widgets = require("../lib/Widgets");
const Screen = require("../lib/Screen");

/**
 * Fake Ollama server. `reply(body)` decides the /api/chat response. Streaming
 * requests get NDJSON chunks like the real server: the content split in two
 * deltas, then a final `done` chunk carrying any tool calls and stats.
 */
async function fakeOllama({ capabilities = ["completion", "tools", "vision", "thinking"], reply }) {
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => (raw += d));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : {};
      requests.push({ url: req.url, body });
      res.setHeader("Content-Type", "application/json");
      if (req.url === "/api/show") return res.end(JSON.stringify({ capabilities }));
      if (req.url === "/api/tags") return res.end(JSON.stringify({ models: [{ name: "test-model:latest" }] }));
      if (req.url === "/api/chat") {
        const message = reply(body, requests);
        if (!body.stream) return res.end(JSON.stringify({ message, done: true }));
        res.setHeader("Content-Type", "application/x-ndjson");
        const text = message.content ?? "";
        const half = Math.ceil(text.length / 2);
        for (const part of [text.slice(0, half), text.slice(half)]) {
          if (part) res.write(`${JSON.stringify({ message: { role: "assistant", content: part }, done: false })}\n`);
        }
        const last = { role: "assistant", content: "", ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}) };
        return res.end(`${JSON.stringify({ message: last, done: true, prompt_eval_count: 42, eval_count: 7 })}\n`);
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

const CONFIG = {
  assistantName: "Iris",
  userName: "Sam",
  locale: "en-GB",
  llm: { fastIntents: true },
  conversation: { historyTurns: 6, resetAfter: 300000 },
  display: { cardTimeout: 60000, infoTimeout: 60000, snapshotTimeout: 8000 },
  customCommands: [{ phrases: ["next page"], notification: "PAGE_INCREMENT", reply: "Next page." }],
};

function build(url, { camera = { available: false }, outfitPlanner = "fast" } = {}) {
  const config = { ...CONFIG, llm: { ...CONFIG.llm, outfitPlanner } };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris-assistant-"));
  const ollama = new Ollama({ url, model: "test-model", maxTokens: 100 });
  const wardrobe = new Wardrobe(dir);
  const memory = new Memory(dir);
  const weather = new Weather();
  weather.updateFromMirror({ current: { temperature: 4, weatherType: "day-rain" }, forecast: [{ maxTemperature: 6, minTemperature: 1 }] });
  // Record every card shown, flattened as { type, ...data }.
  const widgets = new Widgets({ max: 4 });
  const cards = [];
  const add = widgets.add.bind(widgets);
  widgets.add = (spec) => {
    cards.push({ type: spec.type, ...spec.data });
    return add(spec);
  };
  const screen = new Screen();
  const skills = new Skills({
    ollama, wardrobe, memory, camera, weather, search: null, sports: null, widgets, screen,
    config,
  });
  const assistant = new Assistant({ ollama, skills, memory, wardrobe, screen, config });
  return { ollama, wardrobe, memory, skills, assistant, cards, widgets, screen };
}

test("tool-calling loop streams the answer and sends only the relevant tools", async () => {
  const server = await fakeOllama({
    reply: (body) => {
      const last = body.messages.at(-1);
      if (last.role === "user") {
        return { role: "assistant", content: "", tool_calls: [{ function: { name: "memory", arguments: { action: "remember", fact: "Dislikes yellow" } } }] };
      }
      assert.equal(last.role, "tool");
      assert.equal(last.tool_name, "memory");
      return { role: "assistant", content: "**Noted**, no yellow for you from now on! 🎨 Anything else I can help with today?" };
    },
  });
  try {
    const { assistant, memory, skills } = build(server.url);
    await skills.init();
    const sentences = [];
    const reply = await assistant.ask("yellow clothes never suit me", { onSentence: (s) => sentences.push(s) });

    assert.equal(reply, "Noted, no yellow for you from now on! Anything else I can help with today?");
    assert.deepEqual(sentences, ["Noted, no yellow for you from now on!", "Anything else I can help with today?"], "spoken as it streams");
    assert.deepEqual(memory.facts.map((f) => f.text), ["Dislikes yellow"]);

    const chats = server.requests.filter((r) => r.url === "/api/chat").map((r) => r.body);
    const chat = chats[0];
    assert.equal(chat.think, false, "think flag sent to thinking-capable model");
    assert.equal(chat.stream, true);
    assert.match(chat.messages[0].content, /You are Iris, the voice of a smart mirror for Sam/);
    assert.doesNotMatch(chat.messages[0].content, /\d:\d\d/, "no clock time in the system prompt (it would defeat the prompt cache)");
    assert.match(chat.messages.at(-1).content, /^\[[^\]]*\d{1,2}:\d\d[^\]]*\]\n\nyellow clothes never suit me$/, "per-request context rides on the user message");
    const toolNames = chat.tools.map((t) => t.function.name);
    assert.deepEqual(toolNames, ["suggest_outfit", "wardrobe", "memory"], "only tools the request points to");
    assert.ok(!toolNames.includes("look_at_user"), "vision tools hidden without a camera");

    // History keeps messages exactly as sent, so the next prompt extends this one.
    assert.equal(assistant.history[0].content, chat.messages.at(-1).content);
    assert.equal(assistant.history.at(-1).content, reply);

    // A follow-up keeps the tools of the previous exchange ("…and forget it again").
    await assistant.ask("thanks");
    const followUp = server.requests.filter((r) => r.url === "/api/chat").at(-1).body;
    assert.deepEqual(followUp.tools.map((t) => t.function.name), ["memory"]);
    assert.match(followUp.messages[0].content, /About the user:\n- Dislikes yellow/);
  } finally {
    await server.close();
  }
});

test("consecutive questions extend the previous prompt (cache reuse)", async () => {
  const server = await fakeOllama({ reply: () => ({ role: "assistant", content: "Why did the mirror blush? It saw your reflection." }) });
  try {
    const { assistant } = build(server.url);
    await assistant.ask("tell me a joke");
    await assistant.ask("another one");
    const [first, second] = server.requests.filter((r) => r.url === "/api/chat").map((r) => r.body.messages);
    assert.deepEqual(second.slice(0, first.length), first, "second prompt starts with the whole first prompt");
    assert.equal(second.length, first.length + 2);
  } finally {
    await server.close();
  }
});

test("plain questions are sent without tools; style statements are remembered instantly", async () => {
  const server = await fakeOllama({ reply: () => ({ role: "assistant", content: "Octopuses have three hearts and blue blood." }) });
  try {
    const { assistant, memory } = build(server.url);
    assert.equal(await assistant.ask("give me a fun fact about octopuses"), "Octopuses have three hearts and blue blood.");
    const chat = server.requests.find((r) => r.url === "/api/chat").body;
    assert.equal("tools" in chat, false, "no tool list for a plain question");
    assert.match(chat.messages[0].content, /Answer from your own knowledge/);

    const before = server.requests.length;
    assert.equal(await assistant.ask("I really don't like wearing orange"), "Got it, I'll remember that.");
    assert.equal(server.requests.length, before, "no LLM call");
    assert.deepEqual(memory.facts.map((f) => f.text), ["the user really doesn't like wearing orange"]);
  } finally {
    await server.close();
  }
});

test("models without thinking/tools get neither field", async () => {
  const server = await fakeOllama({
    capabilities: ["completion"],
    reply: () => ({ role: "assistant", content: "Paris is the capital of France." }),
  });
  try {
    const { assistant } = build(server.url);
    assert.equal(await assistant.ask("capital of France?"), "Paris is the capital of France.");
    const chat = server.requests.find((r) => r.url === "/api/chat").body;
    assert.equal("think" in chat, false);
    assert.equal("tools" in chat, false);
  } finally {
    await server.close();
  }
});

test("AI outfit stylist uses structured output, validates ids and shows a card", async () => {
  let wardrobeRef;
  const server = await fakeOllama({
    reply: (body) => {
      assert.ok(body.format, "JSON schema sent");
      assert.match(body.messages.at(-1).content, /Weather: Now: 4°C, rain/);
      const coat = wardrobeRef.items.find((i) => i.category === "outerwear");
      return {
        role: "assistant",
        content: JSON.stringify({ title: "Rainy day layers", item_ids: [coat.id, "w-invented"], reason: "it keeps the rain off" }),
      };
    },
  });
  try {
    const { assistant, wardrobe, skills, cards } = build(server.url, { outfitPlanner: "ai" });
    wardrobeRef = wardrobe;
    wardrobe.add({ name: "Grey wool coat", category: "outerwear", colors: ["grey"], warmth: 5 });
    wardrobe.add({ name: "White tee", category: "top", colors: ["white"], warmth: 1 });

    const reply = await assistant.ask("What should I wear today?");
    assert.equal(reply, "How about your grey wool coat? It keeps the rain off.");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].type, "outfit");
    assert.deepEqual(cards[0].items.map((i) => i.name), ["Grey wool coat"]);
    assert.equal(skills.lastSuggestion.itemIds.length, 1);

    // "I'll wear that" → logs the suggestion.
    const logged = skills.logOutfitWorn();
    assert.equal(logged.spoken, "Noted, that's today's outfit.");
    assert.equal(wardrobe.items[0].wearCount, 1);
  } finally {
    await server.close();
  }
});

test("camera skills send the photo to the vision model and save scanned items", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const camera = { available: true, tool: "fake", capture: async () => ({ jpeg, width: 1280, height: 960 }) };
  const server = await fakeOllama({
    reply: (body) => {
      const user = body.messages.at(-1);
      assert.deepEqual(user.images, [jpeg.toString("base64")]);
      if (body.format) {
        return {
          role: "assistant",
          content: JSON.stringify({
            items: [{ name: "Red knit beanie", category: "accessory", colors: ["red"], formality: "casual", warmth: 4, bbox_2d: [100, 50, 400, 300] }],
          }),
        };
      }
      return { role: "assistant", content: "You look sharp. The navy works well with your skin tone." };
    },
  });
  try {
    const { assistant, wardrobe, cards } = build(server.url, { camera });
    await assistant.skills.init();
    assert.equal(assistant.skills.visionReady, true);

    assert.equal(await assistant.ask("how do I look?"), "You look sharp. The navy works well with your skin tone.");
    assert.equal(cards[0].type, "snapshot");

    const reply = await assistant.ask("add this hat to my wardrobe");
    assert.equal(reply, "Got it. I've added Red knit beanie to your wardrobe.");
    assert.equal(wardrobe.items.length, 1);
    assert.deepEqual(wardrobe.items[0].photo.box, { x1: 100, y1: 50, x2: 400, y2: 300 });
    assert.ok(fs.existsSync(path.join(wardrobe.photoDir, wardrobe.items[0].photo.file)));
    assert.equal(cards.at(-1).type, "items");
    assert.match(cards.at(-1).items[0].photo.url, /^\/MMM-AI-Jarvis\/photos\/.+\.jpg$/);
  } finally {
    await server.close();
  }
});

test("health check reports missing models and unreachable server", async () => {
  const server = await fakeOllama({ reply: () => ({}) });
  try {
    const ok = new Ollama({ url: server.url, model: "test-model" });
    assert.deepEqual(await ok.healthCheck(), { problems: [], usable: true });
    const missing = new Ollama({ url: server.url, model: "other:2b" });
    const m = await missing.healthCheck();
    assert.equal(m.usable, false);
    assert.match(m.problems[0], /ollama pull other:2b/);
  } finally {
    await server.close();
  }
  const down = new Ollama({ url: "http://127.0.0.1:9", model: "x" });
  const d = await down.healthCheck();
  assert.equal(d.usable, false);
  assert.match(d.problems[0], /Cannot reach Ollama/);
});

test("failover: a sleeping Mac falls back to the Pi, each with its own model", async () => {
  const pi = await fakeOllama({ reply: (body) => ({ role: "assistant", content: `answer from ${body.model}` }) });
  try {
    const ollama = new Ollama({
      servers: [
        { url: "http://127.0.0.1:9", model: "qwen3.5:4b" }, // the Mac, asleep (nothing listening)
        { url: pi.url, model: "test-model" },
      ],
    });
    const health = await ollama.healthCheck();
    assert.equal(health.usable, true);
    assert.deepEqual(health.problems, [], "an unreachable preferred server isn't a problem while another answers");
    assert.equal(ollama.url, pi.url);

    const res = await ollama.chat({ system: "s", messages: [{ role: "user", content: "hi" }] });
    assert.equal(res.text, "answer from test-model", "the Pi's own model is used");

    // Even without a health check, a failing request moves on to the next server.
    const fresh = new Ollama({ servers: [{ url: "http://127.0.0.1:9", model: "big" }, { url: pi.url, model: "test-model" }] });
    assert.equal((await fresh.generate({ prompt: "hi" })), "answer from test-model");
    assert.equal(fresh.pool.servers[0].up, false);
  } finally {
    await pi.close();
  }
});

test("failover: traffic returns to the preferred server once it is back", async () => {
  const pi = await fakeOllama({ reply: () => ({ role: "assistant", content: "pi" }) });
  const mac = await fakeOllama({ reply: () => ({ role: "assistant", content: "mac" }) });
  try {
    const ollama = new Ollama({ servers: [{ url: mac.url, model: "test-model" }, { url: pi.url, model: "test-model" }] });
    ollama.pool.servers[0].up = false; // the Mac was asleep at the last probe
    assert.equal(await ollama.generate({ prompt: "x" }), "pi");
    await ollama.pool.probeAll(); // the Mac woke up
    assert.equal(await ollama.generate({ prompt: "x" }), "mac");
  } finally {
    await pi.close();
    await mac.close();
  }
});

test("outfit card includes pieces the model names aloud but omits from item_ids", async () => {
  let wardrobeRef;
  const server = await fakeOllama({
    reply: () => {
      const shirt = wardrobeRef.items.find((i) => i.category === "top");
      return {
        role: "assistant",
        content: JSON.stringify({ title: "Sunny layers", item_ids: [shirt.id], reason: "Add the red wool cap for a pop of colour" }),
      };
    },
  });
  try {
    const { assistant, wardrobe, cards } = build(server.url, { outfitPlanner: "ai" });
    wardrobeRef = wardrobe;
    wardrobe.add({ name: "Navy oxford shirt", category: "top", colors: ["navy"] });
    wardrobe.add({ name: "Red wool cap", category: "accessory", colors: ["red"] });
    wardrobe.add({ name: "Grey hoodie", category: "top", colors: ["grey"] });

    const reply = await assistant.ask("what should I wear?");
    assert.deepEqual(cards.at(-1).items.map((i) => i.name), ["Navy oxford shirt", "Red wool cap"]);
    assert.equal(reply, "How about your navy oxford shirt and red wool cap? Add the red wool cap for a pop of colour.");
  } finally {
    await server.close();
  }
});

test("explicit 'on the mirror' requests build a panel with structured output", async () => {
  let reply = { title: "Beach day", lines: ["Sunscreen", "Towel", "Water"], spoken: "Here's your **beach** list." };
  const server = await fakeOllama({
    reply: (body) => {
      assert.ok(body.format, "uses a JSON schema, not free tool choice");
      assert.equal(body.tools, undefined);
      return { role: "assistant", content: JSON.stringify(reply) };
    },
  });
  try {
    const { assistant, widgets } = build(server.url);
    const said = [];
    assert.equal(await assistant.ask("put a packing list for the beach on the mirror", { onSentence: (x) => said.push(x) }), "Here's your beach list.");
    assert.deepEqual(said, ["Sure, putting that on the mirror.", "Here's your beach list."], "acknowledged right away");
    assert.deepEqual(widgets.list("info")[0].data, { title: "Beach day", subtitle: "", lines: ["Sunscreen", "Towel", "Water"] });

    reply = { title: "", lines: [], spoken: "" };
    assert.equal(await assistant.ask("show me a recipe for nothing"), "Sorry, I couldn't put that together.");
  } finally {
    await server.close();
  }
});

test("custom voice commands send notifications without the LLM", async () => {
  const server = await fakeOllama({ reply: () => assert.fail("LLM must not be called") });
  try {
    const { assistant, screen } = build(server.url);
    const sent = [];
    screen.on("notify", (n) => sent.push(n));
    assert.equal(await assistant.ask("Next page please"), "Next page.");
    assert.deepEqual(sent, [{ notification: "PAGE_INCREMENT", payload: null }]);
  } finally {
    await server.close();
  }
});

test("fast outfit planner and weather answers need no language model", async () => {
  const server = await fakeOllama({ reply: () => assert.fail("LLM must not be called") });
  try {
    const { assistant, wardrobe, cards, skills } = build(server.url);
    skills.now = () => new Date(2026, 9, 21, 9, 0);
    wardrobe.add({ name: "Grey hoodie", category: "top", colors: ["grey"], warmth: 3 });
    wardrobe.add({ name: "White tee", category: "top", colors: ["white"], warmth: 1 });
    wardrobe.add({ name: "Dark jeans", category: "bottom", colors: ["blue"], warmth: 3 });
    wardrobe.add({ name: "Khaki shorts", category: "bottom", colors: ["khaki"], warmth: 1 });
    wardrobe.add({ name: "Black rain jacket", category: "outerwear", colors: ["black"], warmth: 3 });
    wardrobe.add({ name: "Tan sandals", category: "shoes", colors: ["tan"], warmth: 1 });
    wardrobe.add({ name: "Brown leather boots", category: "shoes", colors: ["brown"], warmth: 3 });

    // build() reports 4°C and rain from the mirror's weather module.
    const reply = await assistant.ask("what should I wear today?");
    assert.deepEqual(cards.at(-1).items.map((i) => i.name), ["Grey hoodie", "Dark jeans", "Brown leather boots", "Black rain jacket"]);
    assert.equal(reply, "It's 4° and wet, so I'd go with your grey hoodie, dark jeans and brown leather boots. Add the black rain jacket for the rain.");
    assert.equal(skills.lastSuggestion.itemIds.length, 4);

    // Said the way a person would, for 9 in the morning.
    assert.equal(await assistant.ask("how cold is it?"), "It's 4° right now. It'll get up to 6° later.");
    assert.equal(await assistant.ask("will it rain today?"), "Yes, it's raining right now, so take an umbrella.");
    assert.equal(await assistant.ask("do I need a coat?"), "Yes, bundle up. It feels like 4° and it's wet, so wear a warm coat.");
    assert.equal(await assistant.ask("what time is it?"), "It's 9:00.");
    assert.equal(await assistant.ask("how long until Halloween?"), "Halloween is 10 days away, on Saturday, October 31st.");
  } finally {
    await server.close();
  }
});

test("a scan cut off at the token limit keeps the items that were complete", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  const camera = { available: true, tool: "fake", capture: async () => ({ jpeg, width: 960, height: 720 }) };
  const item = (name) => `{"name":"${name}","category":"top","colors":["navy"],"formality":"casual","warmth":2,"bbox_2d":[100,100,400,400]}`;
  const server = await fakeOllama({
    // Truncated mid-way through the third item, as when num_predict runs out.
    reply: () => ({ role: "assistant", content: `{"items":[${item("Navy shirt")},${item("White tee")},{"name":"Grey hood` }),
  });
  try {
    const { assistant, wardrobe } = build(server.url, { camera });
    await assistant.skills.init();
    const reply = await assistant.ask("add these clothes to my wardrobe");
    assert.deepEqual(wardrobe.items.map((i) => i.name), ["Navy shirt", "White tee"]);
    assert.equal(reply, "Got it. I've added Navy shirt and White tee to your wardrobe.");
  } finally {
    await server.close();
  }
});

test("JSON repair closes cut-off output and ignores brackets inside strings", () => {
  const { repairJson } = Ollama;
  assert.equal(repairJson('{"items":[{"a":1},{"b":2},{"c":'), '{"items":[{"a":1},{"b":2}]}');
  assert.equal(repairJson('{"items":[{"name":"x, y]"}], "more":true}'), '{"items":[{"name":"x, y]"}], "more":true}');
  assert.equal(repairJson('Sure! {"a":[1,2]} hope that helps'), '{"a":[1,2]}');
  assert.equal(repairJson('{"items":[{"a":'), null);
});
