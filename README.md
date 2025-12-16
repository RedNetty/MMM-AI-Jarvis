# MMM-AI-Jarvis

**A MagicMirror² Module for a Voice-Activated Smart Assistant**

## Overview

MMM-AI-Jarvis is a module for [MagicMirror²](https://magicmirror.builders/) that transforms your mirror into a voice-activated smart assistant. Leveraging Google Cloud's Vertex AI and web scraping techniques, this module enables natural language interactions, providing information and assistance tailored to your needs.

## Features

- **Voice Recognition**: Interact with your MagicMirror² using voice commands.
- **Natural Language Processing**: Understands and processes natural language queries via Google Cloud's Vertex AI.
- **Web Scraping**: Retrieves real-time information from the web to answer your questions.
- **Customizable Responses**: Tailor the assistant's replies to suit your preferences.

## Installation

1. **Clone the Repository**:
   ```bash
   cd ~/MagicMirror/modules
   git clone https://github.com/RedNetty/MMM-AI-Jarvis.git
   ```

2. **Navigate to the Module Directory**:
   ```bash
   cd MMM-AI-Jarvis
   ```

3. **Install Dependencies**:
   ```bash
   npm install
   ```

## Configuration

Add the module to your `config.js` file:

```javascript
{
  module: 'MMM-AI-Jarvis',
  position: 'bottom_bar', // Choose the desired position
  config: {
    // Configuration options
    apiKey: 'YOUR_GOOGLE_CLOUD_API_KEY',
    language: 'en-US',
    wakeWord: 'Jarvis',
    responseVoice: 'en-US-Wavenet-D',
    // Additional options as needed
  }
}
```

**Configuration Options**:

- `apiKey` (required): Your Google Cloud API key for Vertex AI.
- `language` (optional): Language code for voice recognition and responses (default: 'en-US').
- `wakeWord` (optional): The word that activates the assistant (default: 'Jarvis').
- `responseVoice` (optional): The voice used for responses (default: 'en-US-Wavenet-D').

## Usage

Once installed and configured, activate the assistant by saying the wake word (e.g., "Jarvis") followed by your query. The assistant will process your request and provide a spoken response displayed on the mirror.

## Dependencies

- [MagicMirror²](https://magicmirror.builders/)
- [Google Cloud Vertex AI](https://cloud.google.com/vertex-ai)
- [Node.js](https://nodejs.org/)

## Contributing

Contributions are welcome! Please fork the repository and submit a pull request with your enhancements.

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.

## Acknowledgements

Special thanks to the MagicMirror² community and contributors to related modules that inspired this project. 
