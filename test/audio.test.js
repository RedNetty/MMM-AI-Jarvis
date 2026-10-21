"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const VoiceActivityDetector = require("../lib/audio/VoiceActivityDetector");
const { pcmToWav, chime } = require("../lib/audio/wav");
const { jpegSize, isJpeg } = require("../lib/jpeg");
const WhisperCppSTT = require("../lib/stt/WhisperCppSTT");

const RATE = 16000;

function tone(ms, amplitude) {
  const samples = Math.round((RATE * ms) / 1000);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 300 * i) / RATE) * amplitude), i * 2);
  }
  return buf;
}

test("VAD emits one utterance with pre-roll for speech between silence", () => {
  const vad = new VoiceActivityDetector({ threshold: 500, silenceMs: 300, preRollMs: 200, minUtteranceMs: 200 });
  const utterances = [];
  let starts = 0;
  vad.on("speechstart", () => starts++);
  vad.on("utterance", (pcm) => utterances.push(pcm));

  vad.write(tone(1000, 50)); // room noise
  // Feed speech in odd-sized chunks to exercise frame reassembly.
  const speech = tone(800, 6000);
  for (let i = 0; i < speech.length; i += 999) vad.write(speech.subarray(i, i + 999));
  vad.write(tone(600, 50));

  assert.equal(starts, 1);
  assert.equal(utterances.length, 1);
  const seconds = utterances[0].length / 2 / RATE;
  assert.ok(seconds >= 0.9 && seconds <= 1.4, `utterance length ${seconds}s`);
});

test("VAD discards short blips and ignores input while paused", () => {
  const vad = new VoiceActivityDetector({ threshold: 500, silenceMs: 200, minUtteranceMs: 300 });
  let utterances = 0;
  let discards = 0;
  vad.on("utterance", () => utterances++);
  vad.on("discard", () => discards++);

  vad.write(tone(500, 50));
  vad.write(tone(100, 8000)); // door slam
  vad.write(tone(400, 50));
  assert.equal(utterances, 0);
  assert.equal(discards, 1);

  vad.pause();
  vad.write(tone(800, 8000));
  vad.write(tone(400, 50));
  assert.equal(utterances, 0);
});

test("VAD threshold adapts to a noisy room", () => {
  const vad = new VoiceActivityDetector({ threshold: 100, noiseMultiplier: 3 });
  vad.write(tone(2000, 1500));
  assert.ok(vad.effectiveThreshold > 2000, `threshold ${vad.effectiveThreshold}`);
});

test("VAD recovers when steady noise starts after calibration", () => {
  const vad = new VoiceActivityDetector({ threshold: 300, silenceMs: 300, maxUtteranceMs: 2000, minUtteranceMs: 200 });
  let utterances = 0;
  let discards = 0;
  vad.on("utterance", () => utterances++);
  vad.on("discard", () => discards++);

  vad.write(tone(1000, 30)); // quiet room calibrates a low floor
  vad.write(tone(6000, 2000)); // a fan switches on: steady, above the old threshold
  assert.equal(utterances, 0, "steady noise is never sent to speech-to-text");
  assert.ok(discards >= 1);
  assert.ok(vad.effectiveThreshold > 2000, `re-learned threshold ${vad.effectiveThreshold}`);

  // Speech over the fan is still heard: syllable-like bursts well above the new floor.
  for (let i = 0; i < 4; i++) {
    vad.write(tone(180, 12000));
    vad.write(tone(60, 2000));
  }
  vad.write(tone(500, 2000));
  assert.equal(utterances, 1);
});

test("VAD stationarity check separates hum from speech", () => {
  assert.equal(VoiceActivityDetector.isStationary(Array(100).fill(1500)), true);
  assert.equal(VoiceActivityDetector.isStationary([...Array(50)].flatMap(() => [3000, 400])), false);
  assert.equal(VoiceActivityDetector.isStationary([1, 2, 3]), false, "too short to judge");
});

test("WAV header and chime", () => {
  const wav = pcmToWav(Buffer.alloc(320), 16000);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt32LE(40), 320);
  assert.equal(chime().toString("ascii", 8, 12), "WAVE");
});

test("jpegSize reads SOF dimensions", () => {
  // SOI, APP0 (len 16), SOF0 (len 17, 8-bit, h=480, w=640), EOI
  const app0 = Buffer.concat([Buffer.from([0xff, 0xe0, 0x00, 0x10]), Buffer.alloc(14)]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
  assert.equal(isJpeg(jpeg), true);
  assert.deepEqual(jpegSize(jpeg), { width: 640, height: 480 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
});

test("Whisper output cleaning removes non-speech and hallucinations", () => {
  assert.equal(WhisperCppSTT.clean(" [BLANK_AUDIO] "), "");
  assert.equal(WhisperCppSTT.clean("(music) Thank you."), "");
  assert.equal(WhisperCppSTT.clean(" Iris, what time is it? [ Silence ]"), "Iris, what time is it?");
});

const SpeechQueue = require("../lib/audio/SpeechQueue");

test("SpeechQueue plays streamed sentences in order, synthesising one ahead", async () => {
  const log = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const controller = new AbortController();
  const queue = new SpeechQueue({
    signal: controller.signal,
    synthesize: async (text) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      log.push(`synth:${text}`);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return Buffer.from(text);
    },
    play: async (wav) => {
      log.push(`play:${wav}`);
      await new Promise((r) => setTimeout(r, 15));
      return { interrupted: false };
    },
    onStart: () => log.push("start"),
  });

  queue.push("one");
  await new Promise((r) => setTimeout(r, 2));
  queue.push("two"); // arrives while "one" is being prepared – like streamed LLM output
  queue.push("three");
  await queue.finish();

  assert.deepEqual(log.filter((l) => l.startsWith("play")), ["play:one", "play:two", "play:three"]);
  assert.equal(log.indexOf("start"), log.indexOf("play:one") - 1);
  assert.ok(maxInFlight <= 1, "never synthesises more than one sentence ahead");
});

test("SpeechQueue speaks the first sentence alone, then merges what a fast voice can prepare in time", async () => {
  const synthesized = [];
  const played = [];
  const queue = new SpeechQueue({
    signal: new AbortController().signal,
    mergeChars: 40,
    durationOf: () => 2000, // each clip plays for 2 s…
    synthesize: async (text) => {
      synthesized.push(text);
      return Buffer.from(text); // …and synthesis is instant (Kokoro on a Mac)
    },
    play: async (wav) => {
      played.push(String(wav));
      await new Promise((r) => setTimeout(r, 5));
      return { interrupted: false };
    },
  });
  for (const s of ["Sure.", "It is sunny.", "High of 70.", "Low of 55 tonight.", "Enjoy it."]) queue.push(s);
  await queue.finish();

  assert.equal(synthesized[0], "Sure.", "the opening sentence is never held back");
  assert.deepEqual(synthesized.slice(1), ["It is sunny. High of 70.", "Low of 55 tonight. Enjoy it."], "merged up to mergeChars");
  assert.deepEqual(played, synthesized);
});

test("SpeechQueue doesn't merge more than a slow voice can prepare before the current clip ends", async () => {
  const synthesized = [];
  const queue = new SpeechQueue({
    signal: new AbortController().signal,
    mergeChars: 260,
    durationOf: () => 120, // short clips…
    synthesize: async (text) => {
      synthesized.push(text);
      await new Promise((r) => setTimeout(r, text.length * 4)); // …and a slow voice: 4 ms per character
      return Buffer.from(text);
    },
    play: async () => ({ interrupted: false }),
  });
  for (const s of ["Okay.", "Here is the weather.", "It is sunny.", "Enjoy it."]) queue.push(s);
  await queue.finish();
  // 120 ms × 0.6 / 4 ms per character ≈ 18 characters of budget: nothing fits two sentences.
  assert.deepEqual(synthesized, ["Okay.", "Here is the weather.", "It is sunny.", "Enjoy it."]);
});

test("WAV duration from the header", () => {
  const { pcmToWav, wavDurationMs } = require("../lib/audio/wav");
  assert.equal(wavDurationMs(pcmToWav(Buffer.alloc(24000 * 2), 24000)), 1000);
  assert.equal(wavDurationMs(pcmToWav(Buffer.alloc(22050), 22050)), 500);
  assert.equal(wavDurationMs(Buffer.from("not a wav")), null);
});

test("SpeechQueue prepares a sentence that streams in during playback right away", async () => {
  const events = [];
  let releasePlay;
  const queue = new SpeechQueue({
    signal: new AbortController().signal,
    synthesize: async (text) => {
      events.push(`synth:${text}`);
      return Buffer.from(text);
    },
    play: async (wav) => {
      events.push(`play:${wav}`);
      if (String(wav) === "one") await new Promise((r) => (releasePlay = r));
      return { interrupted: false };
    },
  });
  queue.push("one");
  await new Promise((r) => setTimeout(r, 5));
  queue.push("two"); // the model finished its next sentence while "one" plays
  assert.equal(events.at(-1), "synth:two", "synthesised before 'one' finishes playing");
  releasePlay();
  await queue.finish();
  assert.deepEqual(events, ["synth:one", "play:one", "synth:two", "play:two"]);
});

test("SpeechQueue stops on abort and reports synthesis errors", async () => {
  const controller = new AbortController();
  const played = [];
  const queue = new SpeechQueue({
    signal: controller.signal,
    synthesize: async (t) => Buffer.from(t),
    play: async (wav) => {
      played.push(String(wav));
      controller.abort();
      return { interrupted: true };
    },
  });
  queue.push("first");
  queue.push("second");
  await queue.finish();
  assert.deepEqual(played, ["first"]);

  const failing = new SpeechQueue({
    signal: new AbortController().signal,
    synthesize: async () => {
      throw new Error("tts down");
    },
    play: async () => ({ interrupted: false }),
  });
  failing.push("hello");
  await assert.rejects(failing.finish(), /tts down/);
});

const fs = require("fs");
const os = require("os");
const path = require("path");
const Microphone = require("../lib/audio/Microphone");
const Speaker = require("../lib/audio/Speaker");
const Camera = require("../lib/Camera");

test("macOS: microphone and camera use ffmpeg with AVFoundation", () => {
  assert.deepEqual(new Microphone({ platform: "darwin" }).command().slice(0, 9), [
    "ffmpeg", "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "avfoundation", "-i", ":default",
  ]);
  assert.equal(new Microphone({ platform: "darwin", device: "2" }).command()[8], ":2");
  assert.equal(new Microphone({ platform: "linux" }).command()[0], "arecord");

  const cam = new Camera({ platform: "darwin", device: "/dev/video0", width: 960, rotation: 180 })._command("ffmpeg");
  assert.equal(cam[cam.indexOf("-i") + 1], "default:none", "Linux device paths fall back to the default Mac camera");
  assert.equal(cam[cam.indexOf("-video_size") + 1], "1280x720");
  assert.match(cam[cam.indexOf("-vf") + 1], /scale=960:-2,hflip,vflip$/);
});

test("macOS: speaker plays through afplay from a temporary file", async () => {
  // Stand-in afplay that records the file it was given.
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "iris-bin-"));
  const record = path.join(bin, "played");
  fs.writeFileSync(path.join(bin, "afplay"), `#!/bin/sh\ncp "$1" "${record}"\n`, { mode: 0o755 });
  const PATH = process.env.PATH;
  process.env.PATH = `${bin}:${PATH}`;
  try {
    const wav = pcmToWav(Buffer.alloc(320), 16000);
    const result = await new Speaker({ platform: "darwin" }).play(wav);
    assert.deepEqual(result, { interrupted: false });
    assert.deepEqual(fs.readFileSync(record), wav);
  } finally {
    process.env.PATH = PATH;
  }
});
