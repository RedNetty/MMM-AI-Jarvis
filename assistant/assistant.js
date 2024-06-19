/* MagicMirror
 * Module: assistant
 *
 * By Your Name
 * MIT Licensed.
 */

Module.register("assistant", {
  defaults: {
    vertexAIEndpoint: "",
    vertexAIProjectId: "",
    vertexAIApiKey: "",
    speechRecognitionLanguage: "en-US",
    textToSpeechVoice: "en-US-Standard-C",
  },

  // Module start
  start: function() {
    Log.info("Starting module: " + this.name);
    this.sendSocketNotification("START_ASSISTANT", {
      vertexAIEndpoint: this.config.vertexAIEndpoint,
      vertexAIProjectId: this.config.vertexAIProjectId,
      vertexAIApiKey: this.config.vertexAIApiKey,
      speechRecognitionLanguage: this.config.speechRecognitionLanguage,
      textToSpeechVoice: this.config.textToSpeechVoice,
    });
    this.transcription = "";
    this.response = "";
    this.loading = false;
    this.error = "";
  },

  // DOM structure
  getDom: function() {
    const wrapper = document.createElement("div");
    wrapper.id = "assistant-wrapper";

    // Transcription display
    const transcriptionDiv = document.createElement("div");
    transcriptionDiv.id = "assistant-transcription";
    transcriptionDiv.innerHTML = "Awaiting command...";
    wrapper.appendChild(transcriptionDiv);

    // Response display
    const responseDiv = document.createElement("div");
    responseDiv.id = "assistant-response";
    responseDiv.innerHTML = "AI Assistant is ready!";
    wrapper.appendChild(responseDiv);

    // Status display
    const statusDiv = document.createElement("div");
    statusDiv.id = "assistant-status";
    statusDiv.innerHTML = this.loading ? "Loading..." : "";
    wrapper.appendChild(statusDiv);

    // Error display
    const errorDiv = document.createElement("div");
    errorDiv.id = "assistant-error";
    errorDiv.innerHTML = this.error;
    wrapper.appendChild(errorDiv);

    return wrapper;
  },

  // Handle notifications from MagicMirror
  notificationReceived: function(notification, payload, sender) {
    Log.info("Notification received: " + notification);
  },

  // Handle socket notifications
  socketNotificationReceived: function(notification, payload) {
    Log.info("Socket notification received: " + notification);
    const wrapper = document.getElementById("assistant-wrapper");
    const transcriptionDiv = document.getElementById("assistant-transcription");
    const responseDiv = document.getElementById("assistant-response");
    const statusDiv = document.getElementById("assistant-status");
    const errorDiv = document.getElementById("assistant-error");

    switch(notification) {
      case "TRANSCRIPTION":
        this.transcription = payload;
        if (transcriptionDiv) transcriptionDiv.innerHTML = this.transcription;
        break;

      case "RESPONSE":
        this.response = payload;
        if (responseDiv) responseDiv.innerHTML = this.response;
        this.sendSocketNotification("SPEAK_RESPONSE", this.response);
        break;

      case "LOADING":
        this.loading = payload;
        if (statusDiv) statusDiv.innerHTML = this.loading ? "Loading..." : "";
        break;

      case "ERROR":
        this.error = payload;
        if (errorDiv) errorDiv.innerHTML = this.error;
        break;

      case "STOP_COMMAND":
        Log.info("Stop command received");
        this.stopPlayback();
        break;

      case "REQUEST_CANCELED":
        if (statusDiv) statusDiv.innerHTML = "Request canceled.";
        break;

      case "AUDIO_STOPPED":
        if (statusDiv) statusDiv.innerHTML = "Audio stopped.";
        break;
    }
  },

  // Stop audio playback
  stopPlayback: function() {
    this.sendSocketNotification("STOP_PLAYBACK");
    const statusDiv = document.getElementById("assistant-status");
    if (statusDiv) statusDiv.innerHTML = "Stopping playback...";
  },
});
