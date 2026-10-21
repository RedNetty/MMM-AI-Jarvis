"use strict";

/* MagicMirror² Node Helper: MMM-AI-Jarvis
 * Bridges the mirror front-end and the on-device assistant engine (lib/Iris.js).
 */

const NodeHelper = require("node_helper");
const path = require("path");
const Iris = require("./lib/Iris");
const log = require("./lib/log");

const PHOTO_NAME = /^[\w.-]+\.jpg$/;

module.exports = NodeHelper.create({
  start() {
    this.iris = null;
    this.photoDir = null;
    this.problems = [];
    this._registerPhotoRoute();
    log.info("Node helper started.");
  },

  stop() {
    this.iris?.stop();
  },

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "INIT":
        this._init(payload);
        break;
      case "ASK":
        this.iris?.ask(payload);
        break;
      case "STOP":
        this.iris?.cancel();
        break;
      case "WEATHER":
        this.iris?.updateWeather(payload);
        break;
      case "MODULES":
        this.iris?.updateModules(payload);
        break;
      case "DISMISS_WIDGET":
        this.iris?.dismissWidget(payload);
        break;
      default:
        break;
    }
  },

  _init(config) {
    // Every browser window (and every page reload) sends INIT. Only the first
    // one starts the engine; later ones just receive the current state.
    if (this.iris) {
      this.iris.replayState();
      this.sendSocketNotification("PROBLEMS", this.problems);
      return;
    }

    try {
      this.iris = new Iris(config, { moduleDir: this.path });
      this.photoDir = path.join(this.iris.dataDir, "photos");

      const forward = {
        state: "STATE",
        transcription: "TRANSCRIPTION",
        response: "RESPONSE",
        widgets: "WIDGETS",
        screen: "SCREEN",
        notify: "NOTIFY",
        error: "ERROR",
      };
      for (const [event, notification] of Object.entries(forward)) {
        this.iris.on(event, (payload) => this.sendSocketNotification(notification, payload));
      }
      this.iris.on("problems", (p) => {
        this.problems = p;
        this.sendSocketNotification("PROBLEMS", p);
      });

      this.iris.start();
    } catch (err) {
      log.error(`Failed to start: ${err.stack ?? err.message}`);
      this.iris = null;
      this.sendSocketNotification("PROBLEMS", [err.message]);
    }
  },

  /** Serve wardrobe photos to the mirror UI. */
  _registerPhotoRoute() {
    this.expressApp.get(`/${this.name}/photos/:file`, (req, res) => {
      const file = req.params.file;
      if (!this.photoDir || !PHOTO_NAME.test(file)) {
        res.sendStatus(404);
        return;
      }
      res.sendFile(path.join(this.photoDir, file), { maxAge: "7d" }, (err) => {
        if (err && !res.headersSent) res.sendStatus(404);
      });
    });
  },
});
