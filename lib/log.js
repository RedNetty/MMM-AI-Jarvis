"use strict";

/**
 * Tiny prefixed logger. Debug output is suppressed unless enabled via setDebug().
 */

const PREFIX = "[MMM-AI-Jarvis]";
let debugEnabled = false;

module.exports = {
  setDebug(enabled) {
    debugEnabled = Boolean(enabled);
  },

  debug(...args) {
    if (debugEnabled) console.log(PREFIX, "[debug]", ...args);
  },

  info(...args) {
    console.log(PREFIX, ...args);
  },

  warn(...args) {
    console.warn(PREFIX, ...args);
  },

  error(...args) {
    console.error(PREFIX, ...args);
  },
};
