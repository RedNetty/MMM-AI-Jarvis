/* MagicMirror² Module: MMM-AI-Jarvis
 * A voice-activated smart assistant powered by Google Cloud Vertex AI.
 * https://github.com/RedNetty/MMM-AI-Jarvis
 */

Module.register("MMM-AI-Jarvis", {
  defaults: {
    projectId: "",                // Required: Google Cloud project ID
    location: "us-central1",      // Vertex AI region
    model: "gemini-1.5-pro-001",  // Vertex AI model
    activationKeyword: "jarvis",  // Wake word (case-insensitive)
    speechLanguage: "en-US",      // BCP-47 language code for STT
    ttsVoice: {
      languageCode: "en-US",
      name: "en-US-Neural2-D",
      ssmlGender: "MALE",
    },
    serviceAccountFile: "credentials.json", // Path relative to module dir
    maxTokens: 1024,
    showTranscription: true,
    showResponse: true,
    responseTimeout: 5000, // ms to show error before resetting to idle
  },

  requiresVersion: "2.1.0",

  // ─── Lifecycle ─────────────────────────────────────────────────────────────

  start() {
    Log.info(`[${this.name}] Starting...`);
    this.state = "idle";       // idle | listening | processing | speaking | error
    this.transcription = "";
    this.response = "";
    this.errorMsg = "";
    this.sendSocketNotification("INIT", this.config);
  },

  getStyles() {
    return [`${this.name}.css`];
  },

  getHeader() {
    return null; // No module header
  },

  // ─── DOM ───────────────────────────────────────────────────────────────────

  getDom() {
    const wrapper = document.createElement("div");
    wrapper.className = `${this.name} state-${this.state}`;

    // Animated orb + status label
    const row = document.createElement("div");
    row.className = "status-row";

    const orb = document.createElement("div");
    orb.className = "orb";
    row.appendChild(orb);

    const label = document.createElement("span");
    label.className = "status-label";
    label.textContent = this._statusLabel();
    row.appendChild(label);
    wrapper.appendChild(row);

    // What the user said
    if (this.config.showTranscription && this.transcription) {
      const el = document.createElement("p");
      el.className = "transcription";
      el.innerHTML = `<span class="who you">You:</span> ${this._escapeHtml(this.transcription)}`;
      wrapper.appendChild(el);
    }

    // What the assistant replied
    if (this.config.showResponse && this.response) {
      const el = document.createElement("p");
      el.className = "response";
      el.innerHTML = `<span class="who jarvis">Jarvis:</span> ${this._escapeHtml(this.response)}`;
      wrapper.appendChild(el);
    }

    // Error message
    if (this.errorMsg) {
      const el = document.createElement("p");
      el.className = "error-msg";
      el.textContent = this.errorMsg;
      wrapper.appendChild(el);
    }

    return wrapper;
  },

  _statusLabel() {
    const kw = this.config.activationKeyword || "jarvis";
    return {
      idle:       `Say "${kw}"`,
      listening:  "Listening...",
      processing: "Thinking...",
      speaking:   "Speaking...",
      error:      "Something went wrong",
    }[this.state] ?? "";
  },

  _escapeHtml(str) {
    return str
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  },

  // ─── Notifications ─────────────────────────────────────────────────────────

  socketNotificationReceived(notification, payload) {
    switch (notification) {
      case "STATE_CHANGE":
        this.state = payload;
        if (payload !== "error") this.errorMsg = "";
        this.updateDom(300);
        break;

      case "TRANSCRIPTION":
        this.transcription = payload;
        this.response = ""; // clear previous response
        this.updateDom(150);
        break;

      case "RESPONSE":
        this.response = payload;
        this.updateDom(150);
        break;

      case "ERROR":
        this.state = "error";
        this.errorMsg = payload;
        this.updateDom(200);
        // Auto-recover
        setTimeout(() => {
          if (this.state === "error") {
            this.state = "idle";
            this.errorMsg = "";
            this.updateDom(500);
          }
        }, this.config.responseTimeout);
        break;

      default:
        break;
    }
  },

  notificationReceived(notification) {
    if (notification === "ALL_MODULES_STARTED") {
      Log.info(`[${this.name}] All modules loaded.`);
    }
  },
});
