"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
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
 * Fake Ollama server. `reply(body)` decides the /api/chat response.
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
      if (req.url === "/api/chat") return res.end(JSON.stringify({ message: reply(body, requests) }));
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, requests, close: () => new Promise((r) => server.close(r)) };
}

const CONFIG = {
  assistantName: "Jarvis",
  userName: "Sam",
  locale: "en-GB",
  llm: { fastIntents: true },
  conversation: { historyTurns: 6, resetAfter: 300000 },
  display: { cardTimeout: 60000, infoTimeout: 60000, snapshotTimeout: 8000 },
  customCommands: [{ phrases: ["next page"], notification: "PAGE_INCREMENT", reply: "Next page." }],
};

function build(url, { camera = { available: false } } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jarvis-assistant-"));
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
    config: CONFIG,
  });
  const assistant = new Assistant({ ollama, skills, memory, wardrobe, screen, config: CONFIG });
  return { ollama, wardrobe, memory, skills, assistant, cards, widgets, screen };
}

test("tool-calling loop: remember tool then final answer", async () => {
  const server = await fakeOllama({
    reply: (body) => {
      const last = body.messages.at(-1);
      if (last.role === "user") {
        return { role: "assistant", content: "", tool_calls: [{ function: { name: "remember", arguments: { fact: "Dislikes yellow" } } }] };
      }
      assert.equal(last.role, "tool");
      assert.equal(last.tool_name, "remember");
      return { role: "assistant", content: "**Noted** – no yellow for you! 🎨" };
    },
  });
  try {
    const { assistant, memory, skills } = build(server.url);
    await skills.init();
    const reply = await assistant.ask("I really don't like yellow");

    assert.equal(reply, "Noted – no yellow for you!");
    assert.deepEqual(memory.facts.map((f) => f.text), ["Dislikes yellow"]);

    const chat = server.requests.find((r) => r.url === "/api/chat").body;
    assert.equal(chat.think, false, "think flag sent to thinking-capable model");
    assert.equal(chat.stream, false);
    assert.match(chat.messages[0].content, /You are Jarvis, a friendly voice assistant built into a smart mirror for Sam/);
    const toolNames = chat.tools.map((t) => t.function.name);
    assert.ok(toolNames.includes("suggest_outfit"));
    assert.ok(!toolNames.includes("look_at_user"), "vision tools hidden without a camera");
    assert.ok(!toolNames.includes("web_search"), "search hidden when not configured");

    // History is kept for follow-ups, without tool messages leaking out of order.
    assert.equal(assistant.history[0].role, "user");
    assert.equal(assistant.history.at(-1).content, "Noted – no yellow for you!");
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

test("outfit fast path uses structured output, validates ids and shows a card", async () => {
  let wardrobeRef;
  const server = await fakeOllama({
    reply: (body) => {
      assert.ok(body.format, "JSON schema sent");
      assert.match(body.messages.at(-1).content, /Weather: Now: 4°C, rain/);
      const coat = wardrobeRef.items.find((i) => i.category === "outerwear");
      return {
        role: "assistant",
        content: JSON.stringify({ title: "Rainy day layers", item_ids: [coat.id, "w-invented"], spoken: "Wear your grey coat, it's wet out." }),
      };
    },
  });
  try {
    const { assistant, wardrobe, skills, cards } = build(server.url);
    wardrobeRef = wardrobe;
    wardrobe.add({ name: "Grey wool coat", category: "outerwear", colors: ["grey"], warmth: 5 });
    wardrobe.add({ name: "White tee", category: "top", colors: ["white"], warmth: 1 });

    const reply = await assistant.ask("What should I wear today?");
    assert.equal(reply, "Wear your grey coat, it's wet out.");
    assert.equal(cards.length, 1);
    assert.equal(cards[0].type, "outfit");
    assert.deepEqual(cards[0].items.map((i) => i.name), ["Grey wool coat"]);
    assert.equal(skills.lastSuggestion.itemIds.length, 1);

    // "I'll wear that" → logs the suggestion.
    const logged = skills.logOutfitWorn();
    assert.match(logged.spoken, /Grey wool coat/);
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
    assert.deepEqual(await ok.healthCheck(), []);
    const missing = new Ollama({ url: server.url, model: "other:2b" });
    assert.match((await missing.healthCheck())[0], /ollama pull other:2b/);
  } finally {
    await server.close();
  }
  const down = new Ollama({ url: "http://127.0.0.1:9", model: "x" });
  assert.match((await down.healthCheck())[0], /Cannot reach Ollama/);
});

test("outfit card includes pieces the model names aloud but omits from item_ids", async () => {
  let wardrobeRef;
  const server = await fakeOllama({
    reply: () => {
      const shirt = wardrobeRef.items.find((i) => i.category === "top");
      return {
        role: "assistant",
        content: JSON.stringify({ title: "Sunny layers", item_ids: [shirt.id], spoken: "Wear the navy oxford shirt, and add your red wool cap for style." }),
      };
    },
  });
  try {
    const { assistant, wardrobe, cards } = build(server.url);
    wardrobeRef = wardrobe;
    wardrobe.add({ name: "Navy oxford shirt", category: "top", colors: ["navy"] });
    wardrobe.add({ name: "Red wool cap", category: "accessory", colors: ["red"] });
    wardrobe.add({ name: "Grey hoodie", category: "top", colors: ["grey"] });

    await assistant.ask("what should I wear?");
    assert.deepEqual(cards.at(-1).items.map((i) => i.name), ["Navy oxford shirt", "Red wool cap"]);
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
    assert.equal(await assistant.ask("put a packing list for the beach on the mirror"), "Here's your beach list.");
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
