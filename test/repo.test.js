"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");

// A too-broad .gitignore pattern once hid lib/data/ from the repository, so
// the module worked here but failed to load for everyone else.
test("no module code is ignored by git", { skip: !fs.existsSync(path.join(ROOT, ".git")) }, () => {
  const ignored = execFileSync("git", ["ls-files", "--others", "--ignored", "--exclude-standard", "lib", "scripts", "cards.js", "MMM-AI-Jarvis.js", "MMM-AI-Jarvis.css", "node_helper.js"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  assert.deepEqual(ignored, []);
});
