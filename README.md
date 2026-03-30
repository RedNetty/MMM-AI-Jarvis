# MMM-AI-Jarvis

A [MagicMirror²](https://magicmirror.builders/) module that adds a voice-activated smart assistant to your mirror. Say the wake word, ask a question, and get a spoken response — powered by Google Cloud Vertex AI (Gemini) for language understanding and Google Cloud Text-to-Speech for audio output.

## Features

- 🎙️ **Wake-word activation** — fully configurable trigger phrase
- 🧠 **Gemini via Vertex AI** — accurate, contextual responses
- 🌐 **Live web search** — scrapes Google results to answer time-sensitive queries
- 🔊 **Natural-sounding TTS** — Google Neural2 voices
- 🪞 **Clean mirror UI** — animated status orb with idle / listening / processing / speaking states
- 🔄 **Auto-recovery** — STT stream restarts automatically on timeout or error

## Prerequisites

- [MagicMirror²](https://magicmirror.builders/) v2.1.0+
- Node.js 18+
- `arecord` (ALSA) for microphone capture — install via `sudo apt install alsa-utils`
- `mpg123` for audio playback — install via `sudo apt install mpg123`
- A [Google Cloud](https://cloud.google.com/) project with these APIs enabled:
  - Vertex AI API
  - Cloud Speech-to-Text API
  - Cloud Text-to-Speech API
- A service account JSON key with `roles/aiplatform.user` and the Speech/TTS roles

## Installation

```bash
cd ~/MagicMirror/modules
git clone https://github.com/RedNetty/MMM-AI-Jarvis.git
cd MMM-AI-Jarvis
npm install
```

Copy your Google Cloud service account key into the module directory:

```bash
cp /path/to/your-key.json ~/MagicMirror/modules/MMM-AI-Jarvis/credentials.json
```

## Configuration

Add the module to `~/MagicMirror/config/config.js`:

```js
{
  module: "MMM-AI-Jarvis",
  position: "bottom_center",
  config: {
    projectId: "your-gcp-project-id",   // Required
    activationKeyword: "jarvis",          // Say this to activate
    speechLanguage: "en-US",
    ttsVoice: {
      languageCode: "en-US",
      name: "en-US-Neural2-D",
      ssmlGender: "MALE",
    },
    serviceAccountFile: "credentials.json",
  }
}
```

A full sample config is at [`config/config.js.sample`](config/config.js.sample).

## Configuration Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `projectId` | `string` | — | **Required.** Your GCP project ID |
| `location` | `string` | `"us-central1"` | Vertex AI region |
| `model` | `string` | `"gemini-1.5-pro-001"` | Vertex AI model to use |
| `activationKeyword` | `string` | `"jarvis"` | Wake word (case-insensitive) |
| `speechLanguage` | `string` | `"en-US"` | BCP-47 language code for STT |
| `ttsVoice` | `object` | Neural2-D (en-US Male) | Google TTS voice config |
| `serviceAccountFile` | `string` | `"credentials.json"` | Path to service account key, relative to module dir |
| `maxTokens` | `number` | `1024` | Max response length in tokens |
| `showTranscription` | `boolean` | `true` | Show what you said on the mirror |
| `showResponse` | `boolean` | `true` | Show the assistant's response on the mirror |
| `responseTimeout` | `number` | `5000` | ms before error state auto-resets |

## Usage

1. Start MagicMirror as normal
2. Say your wake word (default: **"Jarvis"**) followed by your question
   > *"Jarvis, what's the weather like today?"*
   > *"Jarvis, tell me the latest football scores."*
   > *"Jarvis, tell me a bedtime story."*
3. Say **"stop"** at any time to cancel playback

## Project Structure

```
MMM-AI-Jarvis/
├── MMM-AI-Jarvis.js     # Frontend module (MagicMirror DOM + socket listener)
├── MMM-AI-Jarvis.css    # Styles and state animations
├── node_helper.js       # Backend: mic → STT → Vertex AI → TTS → playback
├── package.json         # Direct dependencies only
├── config/
│   └── config.js.sample # Example MagicMirror configuration
└── credentials.json     # Your GCP service account key (gitignored)
```

## Dependencies

| Package | Purpose |
|---------|---------|
| `@google-cloud/speech` | Streaming speech-to-text |
| `@google-cloud/text-to-speech` | Neural voice synthesis |
| `@google-cloud/vertexai` | Gemini language model |
| `axios` | HTTP client for web search |
| `cheerio` | HTML parsing for search results |

## License

MIT
