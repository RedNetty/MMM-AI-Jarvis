/* MagicMirror² Module: MMM-AI-Jarvis
 * A private, on-device voice assistant and personal stylist for your mirror.
 * https://github.com/RedNetty/MMM-AI-Jarvis
 */

Module.register("MMM-AI-Jarvis", {
  defaults: {
    assistantName: "Jarvis",
    wakeWord: "jarvis",
    wakeWordAliases: ["jervis", "jarvus", "javis"],
    userName: "",
    language: "en",   // Whisper language code ("en", "de", "fr", …)
    locale: null,     // Date/time formatting; null = MagicMirror's global locale
    units: null,      // "metric" | "imperial"; null = MagicMirror's global units
    dataDir: "data",  // Wardrobe, memory and photos (relative to the module folder)
    debug: false,

    stt: {
      whisperUrl: "http://127.0.0.1:8178",
    },

    tts: {
      provider: "piper", // "piper" | "espeak"
      piperUrl: "http://127.0.0.1:5005",
      piperCommand: "~/.local/share/jarvis/piper-venv/bin/piper",
      piperModel: "~/.local/share/jarvis/voices/en_GB-alan-medium.onnx",
      piperSpeaker: null,
      piperLengthScale: null,
      piperArgs: [],
      espeakVoice: "en-us",
      espeakSpeed: 165,
    },

    llm: {
      ollamaUrl: "http://127.0.0.1:11434",
      model: "qwen3.5:2b", // fastest recommended; "qwen3.5:4b" is smarter but ~35% slower
      visionModel: "", // empty = same as model
      keepAlive: -1,      // keep the model loaded; reloading from an SD card is slow
      temperature: 0.4,
      maxTokens: 160,     // spoken replies are short; fewer tokens = faster on a Pi
      contextSize: 4096,
      think: false,
      fastIntents: true,
      outfitPlanner: "fast", // "fast" = instant rule-based picks; "ai" = the language model chooses (slower on a Pi)
    },

    audio: {
      micDevice: "default",
      speakerDevice: "default",
      vadThreshold: 500,
      noiseMultiplier: 3,
      silenceMs: 750,
      preRollMs: 400,
      minUtteranceMs: 350,
      maxUtteranceMs: 15000,
      allowBargeIn: true,
      chime: true,
      chimeVolume: 0.25,
    },

    camera: {
      enabled: true,
      tool: "auto", // auto | rpicam-still | libcamera-still | fswebcam | ffmpeg | custom
      device: "/dev/video0",
      width: 960,
      height: 720,
      rotation: 0,
      flip: false,
      warmupMs: 1200,
      customCommand: [],
    },

    weather: {
      latitude: null,
      longitude: null,
      locationName: "",
    },

    sports: {
      enabled: true,
      leagues: ["nfl", "nba", "mlb", "nhl", "epl", "mls", "ucl", "laliga", "bundesliga", "seriea"],
    },

    search: {
      searxngUrl: "",
    },

    customCommands: [],

    conversation: {
      listenTimeout: 8000,
      followUpWindow: 8000,
      historyTurns: 6,
      resetAfter: 300000,
    },

    display: {
      showTranscription: true,
      showResponse: true,
      clearAfter: 30000,
      maxWidgets: 4,
      cardTimeout: 90000,
      infoTimeout: 180000,
      snapshotTimeout: 8000,
      errorTimeout: 6000,
      showProblems: true,
      autoHide: ["compliments"], // modules faded out while Jarvis is showing something
    },
  },

  requiresVersion: "2.20.0",

  LOCK: "MMM-AI-Jarvis",
  AUTO_LOCK: "MMM-AI-Jarvis-auto",

  /**
   * Always deep-merge the user's config with the defaults, so overriding one
   * nested option (e.g. `llm: { model: "qwen3.5:2b" }`) keeps the rest of
   * that section. MagicMirror only deep-merges when `configDeepMerge: true`
   * is set on the config.js entry, which is easy to forget.
   */
  setConfig(config) {
    const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
    const merge = (base, override) => {
      const out = { ...base };
      for (const [key, value] of Object.entries(override ?? {})) {
        out[key] = isPlainObject(value) && isPlainObject(base?.[key]) ? merge(base[key], value) : value;
      }
      return out;
    };
    this.config = merge(structuredClone(this.defaults), config);
  },

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  start() {
    Log.info(`[${this.name}] Starting…`);
    this._migrateLegacyConfig();

    const globalConfig = typeof config !== "undefined" ? config : {};
    if (!this.config.units) this.config.units = globalConfig.units === "imperial" ? "imperial" : "metric";
    if (!this.config.locale) this.config.locale = globalConfig.locale || globalConfig.language || "en";

    this.state = "idle";
    this.widgets = new Map(); // id → { el, data, type }
    this.hiddenByJarvis = new Set();
    this.autoHidden = false;
    this.weatherSummary = null;
    this.timers = {};
    this.ticker = null;

    this.sendSocketNotification("INIT", this.config);
  },

  /** Map v2.x (Google Cloud) option names onto the current config. */
  _migrateLegacyConfig() {
    const c = this.config;
    if (c.activationKeyword) c.wakeWord = c.activationKeyword;
    if (typeof c.showTranscription === "boolean") c.display.showTranscription = c.showTranscription;
    if (typeof c.showResponse === "boolean") c.display.showResponse = c.showResponse;
    if (typeof c.responseTimeout === "number") c.display.errorTimeout = c.responseTimeout;
    if (typeof c.maxTokens === "number") c.llm.maxTokens = c.maxTokens;

    const obsolete = ["projectId", "location", "model", "serviceAccountFile", "ttsVoice", "speechLanguage"].filter((k) => k in c);
    if (obsolete.length) {
      Log.warn(`[${this.name}] Ignoring Google Cloud options from v2 (${obsolete.join(", ")}). Jarvis now runs locally – see the README.`);
    }
  },

  getStyles() {
    return [`${this.name}.css`];
  },

  getHeader() {
    return null;
  },

  // ─── DOM ───────────────────────────────────────────────────────────────
  // The DOM is built once and then updated in place. MagicMirror's
  // updateDom() replaces the whole module, which restarts every animation
  // and flickers; in-place updates keep the UI smooth.

  getDom() {
    if (!this.root) this._buildRoot();
    return this.root;
  },

  _buildRoot() {
    const root = this._el("div", "jv state-idle");

    const hud = this._el("div", "jv-hud");
    const orb = this._el("div", "jv-orb");
    orb.append(this._el("span", "jv-orb-ring"), this._el("span", "jv-orb-ring jv-orb-ring--2"), this._el("span", "jv-orb-arc"), this._el("span", "jv-orb-core"));
    const bars = this._el("span", "jv-orb-bars");
    for (let i = 0; i < 5; i++) bars.appendChild(this._el("i"));
    orb.appendChild(bars);
    this.labelEl = this._el("div", "jv-label");
    hud.append(orb, this.labelEl);

    this.problemsEl = this._el("ul", "jv-problems");
    this.dialogEl = this._el("div", "jv-dialog");
    this.userEl = this._el("p", "jv-user");
    this.replyEl = this._el("p", "jv-reply");
    this.dialogEl.append(this.userEl, this.replyEl);
    this.errorEl = this._el("div", "jv-error");
    this.widgetsEl = this._el("div", "jv-widgets");

    root.append(hud, this.problemsEl, this.dialogEl, this.errorEl, this.widgetsEl);
    this.root = root;
    this._renderState();
  },

  _renderState() {
    this.root.className = `jv state-${this.state}`;
    const wake = this._titleCase(this.config.wakeWord);
    this.labelEl.textContent = {
      idle: `Say “${wake}”`,
      listening: "Listening",
      processing: "Thinking",
      speaking: this.config.assistantName,
    }[this.state] ?? "";
  },

  _renderProblems(problems) {
    this.problemsEl.replaceChildren();
    if (!this.config.display.showProblems) return;
    for (const p of problems.slice(0, 3)) this.problemsEl.appendChild(this._el("li", "", p));
  },

  _showUser(text) {
    if (!this.config.display.showTranscription) return;
    clearTimeout(this.timers.clear);
    this.dialogEl.classList.remove("is-cleared");
    this.userEl.textContent = text;
    this.replyEl.replaceChildren();
    this.replyText = "";
    this._restartAnimation(this.userEl, "jv-in");
  },

  /**
   * Show the reply. Replies stream in sentence by sentence; when the new text
   * continues the previous one, only the new words are animated in.
   */
  _showReply(text) {
    if (!this.config.display.showResponse) return;
    clearTimeout(this.timers.clear);
    this.dialogEl.classList.remove("is-cleared");

    const previous = this.replyText ?? "";
    const continues = previous && text.startsWith(previous);
    const fresh = continues ? text.slice(previous.length) : text;
    if (!continues) this.replyEl.replaceChildren();
    this.replyText = text;

    // Reveal word by word; each reveal is capped at ~1.2s.
    const words = fresh.split(/\s+/).filter(Boolean);
    const step = Math.min(45, 1200 / Math.max(words.length, 1));
    const frag = document.createDocumentFragment();
    words.forEach((word, i) => {
      const span = this._el("span", "jv-word", word);
      span.style.animationDelay = `${Math.round(i * step)}ms`;
      frag.append(span, " ");
    });
    this.replyEl.appendChild(frag);
  },

  _scheduleClear() {
    const ms = this.config.display.clearAfter;
    clearTimeout(this.timers.clear);
    if (ms > 0) {
      this.timers.clear = setTimeout(() => {
        if (this.state !== "idle") return;
        this.dialogEl.classList.add("is-cleared");
        this._updateAutoHide();
      }, ms);
    }
  },

  _showError(message) {
    this.errorEl.textContent = message;
    this._restartAnimation(this.errorEl, "jv-in");
    this.errorEl.classList.add("is-visible");
    clearTimeout(this.timers.error);
    this.timers.error = setTimeout(() => this.errorEl.classList.remove("is-visible"), this.config.display.errorTimeout);
  },

  // ─── Widgets ───────────────────────────────────────────────────────────

  /**
   * Keyed diff of the widget list: new cards animate in, removed cards
   * animate out, and existing cards update in place.
   * @param {object[]} list newest first
   */
  _renderWidgets(list) {
    const incoming = new Set(list.map((w) => w.id));

    for (const [id, entry] of this.widgets) {
      if (incoming.has(id)) continue;
      this.widgets.delete(id);
      entry.el.classList.add("is-leaving");
      setTimeout(() => entry.el.remove(), 450);
    }

    list.forEach((w, index) => {
      let entry = this.widgets.get(w.id);
      if (!entry) {
        const el = this._el("section", `jv-card jv-card--${w.type}`);
        entry = { el, type: w.type, data: null };
        this.widgets.set(w.id, entry);
        this._buildWidget(entry, w);
      }
      this._updateWidget(entry, w);
      entry.data = w.data;
      entry.expiresAt = w.expiresAt;

      const at = this.widgetsEl.children[index];
      if (at !== entry.el) this.widgetsEl.insertBefore(entry.el, at ?? null);
    });

    const needsTicker = [...this.widgets.values()].some((e) => e.type === "timer");
    if (needsTicker && !this.ticker) this.ticker = setInterval(() => this._tick(), 250);
    if (!needsTicker && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  },

  _buildWidget(entry, w) {
    const el = entry.el;
    switch (w.type) {
      case "score": {
        const head = this._cardHead();
        entry.leagueEl = head.label;
        entry.statusEl = head.meta;
        const rows = this._el("div", "jv-score");
        entry.rows = ["away", "home"].map(() => {
          const row = this._el("div", "jv-team");
          const logo = this._el("img", "jv-logo");
          logo.alt = "";
          logo.referrerPolicy = "no-referrer";
          logo.onerror = () => logo.classList.add("is-missing");
          const name = this._el("span", "jv-team-name");
          const score = this._el("span", "jv-team-score");
          row.append(logo, name, score);
          rows.appendChild(row);
          return { row, logo, name, score };
        });
        entry.detailEl = this._el("div", "jv-score-detail");
        el.append(head.el, rows, entry.detailEl);
        break;
      }
      case "timer": {
        const head = this._cardHead();
        head.label.textContent = "Timer";
        entry.labelEl = head.meta;
        const body = this._el("div", "jv-timer");
        const ns = "http://www.w3.org/2000/svg";
        const svg = document.createElementNS(ns, "svg");
        svg.setAttribute("viewBox", "0 0 64 64");
        svg.setAttribute("class", "jv-timer-ring");
        const track = document.createElementNS(ns, "circle");
        const arc = document.createElementNS(ns, "circle");
        for (const c of [track, arc]) {
          c.setAttribute("cx", "32");
          c.setAttribute("cy", "32");
          c.setAttribute("r", "28");
        }
        track.setAttribute("class", "jv-timer-track");
        arc.setAttribute("class", "jv-timer-arc");
        svg.append(track, arc);
        entry.arc = arc;
        entry.timeEl = this._el("div", "jv-timer-time");
        body.append(svg, entry.timeEl);
        el.append(head.el, body);
        break;
      }
      case "info": {
        const head = this._cardHead();
        head.label.textContent = this.config.assistantName;
        entry.titleEl = this._el("h3", "jv-info-title");
        entry.subtitleEl = this._el("div", "jv-info-subtitle");
        entry.listEl = this._el("ul", "jv-info-lines");
        el.append(head.el, entry.titleEl, entry.subtitleEl, entry.listEl);
        break;
      }
      case "outfit":
      case "items": {
        const head = this._cardHead();
        head.label.textContent = w.type === "outfit" ? "Outfit" : "Wardrobe";
        entry.metaEl = head.meta;
        entry.titleEl = this._el("h3", "jv-info-title");
        entry.gridEl = this._el("div", "jv-items");
        el.append(head.el, entry.titleEl, entry.gridEl);
        break;
      }
      case "snapshot": {
        const head = this._cardHead();
        head.label.textContent = "Camera";
        entry.metaEl = head.meta;
        const frame = this._el("div", "jv-snapshot");
        entry.img = this._el("img");
        entry.img.alt = "";
        frame.append(entry.img, this._el("span", "jv-scanline"));
        el.append(head.el, frame);
        break;
      }
      default:
        break;
    }
  },

  _updateWidget(entry, w) {
    const d = w.data;
    switch (w.type) {
      case "score": {
        const live = d.state === "in";
        entry.el.classList.toggle("is-live", live);
        entry.el.classList.toggle("is-final", d.state === "post");
        entry.leagueEl.textContent = d.league?.name ?? "";
        entry.statusEl.replaceChildren();
        if (live) entry.statusEl.append(this._el("span", "jv-live-dot"), document.createTextNode("Live"));
        else entry.statusEl.textContent = d.state === "post" ? "Final" : "Upcoming";

        const showScores = d.state !== "pre";
        const a = Number(d.away.score);
        const h = Number(d.home.score);
        [d.away, d.home].forEach((team, i) => {
          const r = entry.rows[i];
          if (team.logo && r.logo.dataset.src !== team.logo) {
            r.logo.dataset.src = team.logo;
            r.logo.classList.remove("is-missing");
            r.logo.src = team.logo;
          }
          if (!team.logo) r.logo.classList.add("is-missing");
          r.name.textContent = team.short || team.name;
          const previous = r.score.textContent;
          r.score.textContent = showScores ? team.score : "";
          if (entry.data && showScores && previous !== "" && previous !== team.score) this._restartAnimation(r.score, "jv-flash");
          const leading = showScores && (i === 0 ? a > h : h > a);
          r.row.classList.toggle("is-leading", leading || (d.state === "post" && team.winner));
          r.row.classList.toggle("is-trailing", showScores && !leading && a !== h);
        });
        entry.detailEl.textContent = d.state === "pre" ? this._formatKickoff(d.date) : d.detail;
        break;
      }
      case "timer":
        entry.labelEl.textContent = d.label ? this._titleCase(d.label) : "";
        this._updateTimer(entry, d);
        break;
      case "info":
        entry.titleEl.textContent = d.title;
        entry.subtitleEl.textContent = d.subtitle ?? "";
        entry.subtitleEl.hidden = !d.subtitle;
        entry.listEl.replaceChildren(...(d.lines ?? []).map((line) => this._el("li", "", line)));
        break;
      case "outfit":
      case "items":
        entry.titleEl.textContent = d.title;
        entry.metaEl.replaceChildren();
        if (d.weather) {
          const wx = [d.weather.condition, [d.weather.high, d.weather.low].filter(Boolean).join(" / "), d.weather.rain && `${d.weather.rain} rain`].filter(Boolean);
          entry.metaEl.textContent = wx.join(" · ");
        }
        entry.gridEl.replaceChildren(...(d.items ?? []).map((item) => this._renderItem(item)));
        break;
      case "snapshot":
        entry.metaEl.textContent = d.title ?? "";
        if (entry.img.src !== d.image) entry.img.src = d.image;
        break;
      default:
        break;
    }
  },

  _tick() {
    for (const entry of this.widgets.values()) {
      if (entry.type === "timer" && entry.data) this._updateTimer(entry, entry.data);
    }
  },

  _updateTimer(entry, d) {
    const left = Math.max(0, d.endsAt - Date.now());
    const secs = Math.ceil(left / 1000);
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    const pad = (n) => String(n).padStart(2, "0");
    entry.timeEl.textContent = h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;

    const circumference = 2 * Math.PI * 28;
    const progress = d.durationMs ? left / d.durationMs : 0;
    entry.arc.style.strokeDasharray = `${circumference}`;
    entry.arc.style.strokeDashoffset = `${circumference * (1 - progress)}`;
    entry.el.classList.toggle("is-ending", secs <= 10);
  },

  _cardHead() {
    const el = this._el("div", "jv-card-head");
    const label = this._el("span", "jv-card-label");
    const meta = this._el("span", "jv-card-meta");
    el.append(label, meta);
    return { el, label, meta };
  },

  _renderItem(item) {
    const tile = this._el("figure", "jv-item");
    const frame = this._el("div", "jv-item-photo");

    if (item.photo?.url) {
      frame.appendChild(this._photoCrop(item.photo));
    } else {
      const swatch = this._el("div", "jv-swatch");
      const color = (item.colors ?? []).find((c) => window.CSS?.supports?.("color", c));
      if (color) swatch.style.setProperty("--swatch", color);
      swatch.textContent = (item.category ?? "?").slice(0, 1).toUpperCase();
      frame.appendChild(swatch);
    }

    tile.append(frame, this._el("figcaption", "jv-item-name", item.name));
    return tile;
  },

  /**
   * Show only the item's bounding box from a shared photo, without
   * distortion, using CSS background sizing (no server-side cropping needed).
   */
  _photoCrop(photo) {
    const SIZE = 80;
    const inner = this._el("div", "jv-crop");
    inner.style.backgroundImage = `url("${photo.url}")`;

    const box = photo.box ?? { x1: 0, y1: 0, x2: 1000, y2: 1000 };
    const fw = Math.max(0.01, (box.x2 - box.x1) / 1000);
    const fh = Math.max(0.01, (box.y2 - box.y1) / 1000);
    const aspect = ((photo.width || 4) * fw) / ((photo.height || 3) * fh);

    inner.style.width = `${aspect >= 1 ? SIZE : Math.round(SIZE * aspect)}px`;
    inner.style.height = `${aspect >= 1 ? Math.round(SIZE / aspect) : SIZE}px`;
    inner.style.backgroundSize = `${100 / fw}% ${100 / fh}%`;
    inner.style.backgroundPosition = `${fw >= 1 ? 0 : ((box.x1 / 1000) / (1 - fw)) * 100}% ${fh >= 1 ? 0 : ((box.y1 / 1000) / (1 - fh)) * 100}%`;
    return inner;
  },

  _formatKickoff(date) {
    if (!date) return "";
    const d = new Date(date);
    const today = new Date().toDateString() === d.toDateString();
    const time = d.toLocaleTimeString(this.config.locale, { hour: "numeric", minute: "2-digit" });
    return today ? `Today · ${time}` : `${d.toLocaleDateString(this.config.locale, { weekday: "short", month: "short", day: "numeric" })} · ${time}`;
  },

  // ─── Helpers ───────────────────────────────────────────────────────────

  _el(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  },

  _restartAnimation(el, className) {
    el.classList.remove(className);
    void el.offsetWidth; // force reflow so the animation runs again
    el.classList.add(className);
  },

  _titleCase(s) {
    return String(s).replace(/\b\w/g, (c) => c.toUpperCase());
  },

  // ─── Other modules ─────────────────────────────────────────────────────

  /** Tell the helper which modules are on screen, so voice commands can target them. */
  _reportModules() {
    const modules = MM.getModules()
      .filter((m) => m.data?.position)
      .map((m) => ({
        id: m.identifier,
        name: m.name,
        header: m.data.header || "",
        position: m.data.position,
        hidden: Boolean(m.hidden),
      }));
    this.sendSocketNotification("MODULES", modules);
  },

  /**
   * Fade out the modules in display.autoHide (e.g. compliments, which shares
   * the lower third with Jarvis) while Jarvis has something on screen, and
   * bring them back once it is idle with nothing showing.
   */
  _updateAutoHide() {
    const names = this.config.display.autoHide ?? [];
    if (!names.length) return;

    const hasDialog = Boolean(this.userEl.textContent || this.replyEl.textContent) && !this.dialogEl.classList.contains("is-cleared");
    const active = this.state !== "idle" || this.widgets.size > 0 || hasDialog;
    if (active === this.autoHidden) return;
    this.autoHidden = active;

    const options = { lockString: this.AUTO_LOCK };
    for (const m of MM.getModules()) {
      if (m === this || !names.includes(m.name)) continue;
      if (active) m.hide(500, () => {}, options);
      else m.show(800, () => {}, options);
    }
  },

  _applyScreenCommand({ action, ids }) {
    const done = () => this._reportModules();
    const byId = (id) => MM.getModules().find((m) => m.identifier === id);
    const options = { lockString: this.LOCK };

    if (action === "hide") {
      for (const id of ids) {
        const m = byId(id);
        if (!m || m === this) continue;
        this.hiddenByJarvis.add(id);
        m.hide(600, done, options);
      }
    } else if (action === "show") {
      for (const id of ids) {
        const m = byId(id);
        if (!m) continue;
        this.hiddenByJarvis.delete(id);
        m.show(600, done, options);
      }
    } else if (action === "restore") {
      for (const id of this.hiddenByJarvis) byId(id)?.show(600, done, options);
      this.hiddenByJarvis.clear();
    }
  },

  // ─── Notifications ─────────────────────────────────────────────────────

  socketNotificationReceived(notification, payload) {
    if (!this.root) this._buildRoot();

    switch (notification) {
      case "STATE":
        this.state = payload;
        this._renderState();
        this.sendNotification("JARVIS_STATE", { state: payload });
        if (payload === "idle") this._scheduleClear();
        this._updateAutoHide();
        break;
      case "TRANSCRIPTION":
        this._showUser(payload);
        break;
      case "RESPONSE":
        this._showReply(payload);
        this.sendNotification("JARVIS_RESPONSE", { text: payload });
        break;
      case "WIDGETS":
        this._renderWidgets(Array.isArray(payload) ? payload : []);
        this._updateAutoHide();
        break;
      case "SCREEN":
        this._applyScreenCommand(payload);
        break;
      case "NOTIFY":
        if (payload?.notification) this.sendNotification(payload.notification, payload.payload ?? null);
        break;
      case "ERROR":
        this._showError(payload);
        break;
      case "PROBLEMS":
        this._renderProblems(Array.isArray(payload) ? payload : []);
        break;
      default:
        break;
    }
  },

  notificationReceived(notification, payload, sender) {
    switch (notification) {
      case "DOM_OBJECTS_CREATED":
        this._reportModules();
        break;
      case "JARVIS_ASK": {
        const text = typeof payload === "string" ? payload : payload?.text;
        if (text) this.sendSocketNotification("ASK", text);
        break;
      }
      case "JARVIS_STOP":
        this.sendSocketNotification("STOP");
        break;
      case "WEATHER_UPDATED":
        this._forwardWeather(payload, sender);
        break;
      default:
        break;
    }
  },

  /**
   * Reuse the weather module's data so outfit suggestions need no extra
   * weather calls. Since MagicMirror 2.38 the values are in the sending
   * weather module's units, so those are forwarded too.
   */
  _forwardWeather(payload, sender) {
    if (!payload) return;
    const cur = payload.currentWeather;
    const forecast = Array.isArray(payload.forecastArray) ? payload.forecastArray : null;
    const next = { ...(this.weatherSummary ?? {}) };

    next.units = sender?.config?.units === "imperial" ? "imperial" : "metric";
    if (payload.locationName) next.locationName = payload.locationName;
    if (cur) {
      next.current = {
        temperature: cur.temperature ?? null,
        feelsLike: cur.feelsLikeTemp ?? null,
        humidity: cur.humidity ?? null,
        windSpeed: cur.windSpeed ?? null,
        weatherType: cur.weatherType ?? null,
      };
    }
    if (forecast?.length) {
      next.forecast = forecast.slice(0, 2).map((f) => ({
        maxTemperature: f.maxTemperature ?? null,
        minTemperature: f.minTemperature ?? null,
        precipitationProbability: f.precipitationProbability ?? null,
        weatherType: f.weatherType ?? null,
        windSpeed: f.windSpeed ?? null,
      }));
    }

    this.weatherSummary = next;
    this.sendSocketNotification("WEATHER", next);
  },
});
