const NodeHelper = require('node_helper');
const { VertexAI } = require('@google-cloud/vertexai');
const speech = require('@google-cloud/speech');
const { TextToSpeechClient } = require('@google-cloud/text-to-speech');
const player = require('play-sound')();
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const axios = require('axios');
const cheerio = require('cheerio');
const util = require('util');
const path = require('path');
const { spawn, exec } = require('child_process');
const { PassThrough } = require("stream");

const ROOT_DIR = __dirname;
const credentialsPath = path.join(ROOT_DIR, "credentials.json");
const audioFilePath = path.join(ROOT_DIR, 'output.mp3');

process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;

const vertexAI = new VertexAI({ project: 'savvy-climber-372121', location: 'us-central1' });
const model = 'gemini-1.5-pro-001';

const generativeModel = vertexAI.getGenerativeModel({
  model: model,
  generationConfig: {
    maxOutputTokens: 2000,
    temperature: 1,
    topP: 0.95,
  },
});

let isProcessing = false;
let audioProcess = null;
let currentRequest = null;

module.exports = NodeHelper.create({
  // Initializes the helper and starts listening
  start() {
    console.log('Assistant helper started...');
    this.startListening();
  },

  // Starts listening for audio input
  startListening() {
    console.log('Starting to listen for audio...');
    this.startMicrophoneStream();
  },

  // Configures and starts the microphone stream
  startMicrophoneStream() {
    const micStream = new PassThrough();
    const micProcess = spawn('arecord', ['-f', 'S16_LE', '-r', '16000', '-c', '1']);

    micProcess.stdout.pipe(micStream);

    micProcess.stderr.on('data', data => {
      console.error(`arecord stderr: ${data}`);
    });

    micProcess.on('error', error => {
      console.error(`Error spawning arecord: ${error}`);
    });

    micProcess.on('close', code => {
      console.log(`arecord process exited with code ${code}`);
      if (code !== 0) {
        console.log('Restarting microphone stream...');
        setTimeout(() => this.startMicrophoneStream(), 1000);
      }
    });

    this.setupSpeechRecognition(micStream);
  },

  // Sets up speech recognition with Google Cloud Speech-to-Text
  setupSpeechRecognition(audioStream) {
    const speechClient = new speech.SpeechClient();

    const request = {
      config: {
        encoding: 'LINEAR16',
        sampleRateHertz: 16000,
        languageCode: 'en-US',
      },
      interimResults: false,
    };

    const recognizeStream = speechClient
      .streamingRecognize(request)
      .on('error', error => {
        console.error('Error in speech recognition:', error);
        if (error.code === 11) {
          console.log('Restarting speech recognition due to audio timeout...');
          this.startMicrophoneStream();
        }
        isProcessing = false;
      })
      .on('data', data => {
        const transcription = data.results
          .map(result => result.alternatives[0].transcript)
          .join('\n')
          .toLowerCase();

        console.log(`Transcription: ${transcription}`);

        if (/\bstop\b/.test(transcription)) {
          console.log('Stop command detected.');
          this.sendSocketNotification('STOP_COMMAND');
          this.stopAll();
          isProcessing = false;
        } else if (!isProcessing && transcription.includes('jarvis')) {
          if (transcription.includes('who is the prettiest of them all') || transcription.includes('the prettiest of them all')) {
            const reply = "You are of course";
            this.sendSocketNotification("RESPONSE", reply);
            this.speakResponse(reply);
            isProcessing = true;
            return;
          }
          console.log('Activation word detected.');
          this.sendSocketNotification('TRANSCRIPTION', transcription);
          this.handleQuery(transcription.replace('jarvis', '').trim());
          isProcessing = true;
        } else {
          console.log('Activation word not detected or processing ongoing.');
        }
      })
      .on('end', () => {
        isProcessing = false;
      });

    audioStream.pipe(recognizeStream);
  },

  // Stops all ongoing processes and requests
  stopAll() {
    if (audioProcess) {
      audioProcess.kill('SIGKILL');
      audioProcess = null;
      console.log('Audio playback stopped.');
      this.sendSocketNotification('AUDIO_STOPPED');
    }

    if (currentRequest) {
      currentRequest.cancel();
      currentRequest = null;
      console.log('Current request canceled.');
      this.sendSocketNotification('REQUEST_CANCELED');
    }
  },

  // Handles the user query
  async handleQuery(query) {
    try {
      this.sendSocketNotification('LOADING', true);
      currentRequest = axios.CancelToken.source();

      let searchContext = '';
      if (this.requiresSearchResults(query)) {
        searchContext = await this.scrapeWebResults(query, currentRequest.token);
      }

      const refinedQuery = `User query: ${query} \n\nUse the search context to Answer (ALWAYS CHECK THIS TO SEE IF IT ANSWERS THE QUESTION) Search context:\n${searchContext}\n`;
      const refinedContext = `If there is no search context, provide a response based on your existing knowledge. If there is search context, use it to provide a specific and accurate response to the user's query. Ensure the response is concise and relevant.`;

      const fullQuery = `${refinedQuery}\n${refinedContext}`;

      const response = await this.queryVertexAI(fullQuery);
      console.log('Generated response:', response);

      let textResponse = response.candidates[0].content.parts[0].text;
      textResponse = this.cleanResponse(textResponse);
      this.sendSocketNotification('RESPONSE', textResponse);
      await this.speakResponse(textResponse);
    } catch (error) {
      if (axios.isCancel(error)) {
        console.log('Request canceled:', error.message);
      } else {
        console.error('Error handling query:', error);
        await this.speakResponse("Sorry, I couldn't process your request.");
        this.sendSocketNotification('ERROR', "Sorry, I couldn't process your request.");
      }
    } finally {
      this.sendSocketNotification('LOADING', false);
      currentRequest = null;
      isProcessing = false;
    }
  },

  // Determines if the query requires search results
  requiresSearchResults(query) {
    const lowercaseQuery = query.toLowerCase();
    const excludedPhrases = [
      'read me a bedtime story',
      'tell me a story',
      'generate a story',
      // Add more phrases that don't require search results
    ];

    return !excludedPhrases.some(phrase => lowercaseQuery.includes(phrase));
  },

  // Scrapes web results using Google search
  async scrapeWebResults(query, cancelToken) {
    const baseURL = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/101.0.4951.54 Safari/537.36'
    };

    const results = [];
    const pages = 2;
    try {
      for (let i = 0; i < pages; i++) {
        const start = i * 10;
        const url = `${baseURL}&start=${start}`;
        const { data } = await axios.get(url, { headers, cancelToken });
        const $ = cheerio.load(data);

        $('.tF2Cxc').each((index, element) => {
          const title = $(element).find('.DKV0Md').text();
          const snippet = $(element).find('.VwiC3b').text();
          results.push({ title, link: '', snippet });
        });

        // Check for live scores and add them to the results
        $('.imspo_mt__score-imspo_mt__ft-score').each((index, element) => {
          const match = $(element).find('.imspo_mt__t .imspo_mt__tnal-cont').text().trim();
          const score = $(element).find('.imspo_mt__s').text().trim();
          results.push({ title: `Live Score: ${match}`, link: '', snippet: score });
        });
      }

      console.log(results);
      return results.map(result => `${result.title}: ${result.snippet} - ${result.link}`).join('\n');
    } catch (error) {
      console.error('Error fetching data:', error);
      return 'No relevant search results found.';
    }
  },

  // Queries Vertex AI for a response
  async queryVertexAI(query) {
    try {
      const request = {
        contents: [{ role: 'user', parts: [{ text: query }] }],
      };
      const streamingResult = await generativeModel.generateContentStream(request);
      let aggregatedResponse = '';
      for await (const item of streamingResult.stream) {
        console.log('stream chunk: ' + JSON.stringify(item));
        aggregatedResponse += item.candidates[0].content.parts[0].text;
      }
      console.log('aggregated response: ' + aggregatedResponse);
      return streamingResult.response;
    } catch (error) {
      console.error("Error querying Vertex AI:", error);
      return { candidates: [{ content: { parts: [{ text: "Sorry, I couldn't understand that." }] } }] };
    }
  },

  // Cleans the response text
  cleanResponse(text) {
    return text.replace(/\*/g, '').replace(/(?:https?|ftp):\/\/[\n\S]+/g, '').replace(/[^\x00-\x7F]/g, '');
  },

  // Converts text response to speech and plays it
  async speakResponse(text) {
    const client = new TextToSpeechClient({ credentials: require(credentialsPath) });

    const request = {
      input: { text: text },
      voice: { languageCode: 'en-AU', ssmlGender: 'MALE' },
      audioConfig: { audioEncoding: 'MP3' },
    };

    try {
      const [response] = await client.synthesizeSpeech(request);
      await util.promisify(fs.writeFile)(audioFilePath, response.audioContent, 'binary');
      console.log('Audio content written to file:', audioFilePath);

      audioProcess = exec(`mpg123 ${audioFilePath}`, (error, stdout, stderr) => {
        if (error) {
          console.error(`Error playing audio: ${error}`);
          this.sendSocketNotification('ERROR', "Sorry, I couldn't generate audio.");
        }
        console.log(`Audio playback finished.`);
        this.sendSocketNotification('AUDIO_FINISHED');
        audioProcess = null;
      });
    } catch (err) {
      console.error('ERROR:', err);
      this.sendSocketNotification('ERROR', "Sorry, I couldn't generate audio.");
    } finally {
      isProcessing = false;
    }
  }
});
