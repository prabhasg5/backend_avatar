import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import ElevenLabs from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import axios from "axios";
import path from "path";
import { createHash } from "crypto";
import { createReadStream } from "fs";
dotenv.config();

// Replace OpenAI with Llama 3.2 configuration
const llamaApiKey = process.env.LLAMA_API_KEY || "";
const llamaApiUrl = process.env.LLAMA_API_URL || "https://api.groq.com/openai/v1/chat/completions";

const elevenLabsApiKey = process.env.ELEVEN_LABS_API_KEY;
const voiceID = "3gsg3cxXyFLcGIfNbM6C"; //Raju voice ID

// Initialize ElevenLabs
const elevenLabs = new ElevenLabs({
    apiKey: elevenLabsApiKey,
    voiceId: voiceID
});

const app = express();
app.use(express.json());
app.use(cors());
const port = 3000;

// In-memory cache for expensive operations
const audioCache = new Map();
const responseCache = new Map();
const staticFileCache = new Map();
const llamaResponseCache = new Map();
const MAX_CACHE_SIZE = 100; // Limit cache sizes

// Persistent cache configuration
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

// Preload common responses
const PRELOADED_RESPONSES = {
  emptyMessage: null,
  noApiKeys: null,
  error: null
};

// Ensure directories exist
async function ensureDirectoryExists(directory) {
  try {
    await fs.access(directory);
  } catch (error) {
    await fs.mkdir(directory, { recursive: true });
    console.log(`Created directory: ${directory}`);
  }
}

// Stream-based file reading for better performance
async function readFileAsStream(filePath, encoding = null) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = createReadStream(filePath, encoding ? { encoding } : undefined);
    
    stream.on('data', chunk => chunks.push(chunk));
    stream.on('end', () => {
      if (encoding) {
        resolve(chunks.join(''));
      } else {
        resolve(Buffer.concat(chunks).toString('base64'));
      }
    });
    stream.on('error', reject);
  });
}

// Initialize app with preloaded responses
(async () => {
  await ensureDirectoryExists('audios');
  await ensureDirectoryExists('cache');
  
  // Preload common responses
  try {
    // Empty message response
    const [introAudio, introLipsync] = await Promise.all([
      readFileAsStream("audios/ElevenLabs_2025-03-08T03_59_21_Bill_pre_s50_sb75_se0_b_m2.wav"),
      fs.readFile("audios/intro_0.json", "utf8").then(JSON.parse)
    ]);
    
    PRELOADED_RESPONSES.emptyMessage = {
      messages: [
        {
          text: "Hey dear... How was your day?",
          audio: introAudio,
          lipsync: introLipsync,
          facialExpression: "smile",
          animation: "talking_1",
        },
      ],
    };
    
    // No API keys response
    const [api0Audio, api0Lipsync, api1Audio, api1Lipsync] = await Promise.all([
      readFileAsStream("audios/api_0.wav"),
      fs.readFile("audios/api_0.json", "utf8").then(JSON.parse),
      readFileAsStream("audios/api_1.wav"),
      fs.readFile("audios/api_1.json", "utf8").then(JSON.parse)
    ]);
    
    PRELOADED_RESPONSES.noApiKeys = {
      messages: [
        {
          text: "Please my dear, don't forget to add your API keys!",
          audio: api0Audio,
          lipsync: api0Lipsync,
          facialExpression: "angry",
          animation: "talking_2",
        },
        {
          text: "You don't want to ruin Wawa Sensei with a crazy Llama and ElevenLabs bill, right?",
          audio: api1Audio,
          lipsync: api1Lipsync,
          facialExpression: "smile",
          animation: "laughing_slowly",
        },
      ],
    };
    
    // Error response
    PRELOADED_RESPONSES.error = {
      messages: [
        {
          text: "I'm sorry, there was an error connecting to my brain. Can we try again?",
          facialExpression: "sad",
          animation: "silly_dance",
        },
      ],
    };
    
    console.log("Preloaded common responses");
  } catch (error) {
    console.error("Error preloading responses:", error);
  }
})();

// Generate a hash for text to use as cache key
function getTextHash(text) {
  return createHash('md5').update(text).digest('hex');
}

// Generate a hash for the entire user request
function getRequestHash(message) {
  return createHash('md5').update(message || "empty").digest('hex');
}

// Execute command with promise-based timeout and cancellation
const execCommandWithTimeout = (command, timeoutMs = 10000) => {
  return new Promise((resolve, reject) => {
    const childProcess = exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
    
    // Set timeout to kill process if it takes too long
    const timeout = setTimeout(() => {
      childProcess.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    
    // Clear timeout if process finishes
    childProcess.on('exit', () => clearTimeout(timeout));
  });
};

// Optimized lipsync generation with proper error handling
// Enhanced lip-sync generation with better error handling and retries
const generateLipSync = async (wavFile, jsonFile, retryCount = 1) => {
  try {
    console.log(`Generating lip-sync for ${wavFile} (attempt ${retryCount})`);
    
    // Check if input WAV file exists before trying to process it
    try {
      await fs.access(wavFile);
    } catch (err) {
      console.error(`WAV file doesn't exist: ${wavFile}`);
      return false;
    }
    
    // Verify WAV file has content and isn't zero bytes
    const stats = await fs.stat(wavFile);
    if (stats.size === 0) {
      console.error(`WAV file is empty: ${wavFile}`);
      return false;
    }

    // Use a longer timeout for first attempt, shorter for retries
    const timeout = retryCount === 1 ? 10000 : 6000;
    
    // Execute Rhubarb with detailed output
    try {
      await execCommandWithTimeout(
        `./bin/rhubarb -f json -o "${jsonFile}" "${wavFile}" -r phonetic --logLevel info`,
        timeout
      );
    } catch (execError) {
      console.error(`Rhubarb execution failed: ${execError.message}`);
      
      // Retry once with different recognizer if first attempt failed
      if (retryCount === 1) {
        console.log(`Retrying with different recognizer for ${wavFile}`);
        return generateLipSync(wavFile, jsonFile, retryCount + 1);
      }
      return false;
    }
    
    // Verify the file was created and is valid
    try {
      const data = await fs.readFile(jsonFile, 'utf8');
      const json = JSON.parse(data);
      
      // Check if the file contains valid lipsync data
      if (json && json.mouthCues && json.mouthCues.length > 0) {
        console.log(`Successful lip-sync generation for ${wavFile}`);
        return true;
      } else {
        console.warn(`Generated lipsync file has invalid format: ${jsonFile}`);
        return false;
      }
    } catch (err) {
      console.warn(`Generated lipsync file is invalid: ${err.message}`);
      return false;
    }
  } catch (error) {
    console.error(`Lip sync generation failed with error: ${error.message}`);
    return false;
  }
};

// Convert mp3 to wav with optimized settings and verification
// Enhanced MP3 to WAV conversion with better error handling and validation
const convertMp3ToWav = async (mp3File, wavFile) => {
  try {
    // First check if input MP3 file exists
    try {
      await fs.access(mp3File);
    } catch (err) {
      console.error(`MP3 file doesn't exist: ${mp3File}`);
      return false;
    }
    
    // Check file size to ensure it's not empty
    const stats = await fs.stat(mp3File);
    if (stats.size === 0) {
      console.error(`MP3 file is empty: ${mp3File}`);
      return false;
    }
    
    console.log(`Converting ${mp3File} to ${wavFile}`);
    
    // Use optimized FFmpeg settings for speech with better error output
    await execCommandWithTimeout(
      `ffmpeg -y -i "${mp3File}" -ar 16000 -ac 1 -acodec pcm_s16le "${wavFile}" -v warning`, 
      5000 // 5 second timeout
    );
    
    // Verify the file exists and has content
    try {
      await fs.access(wavFile);
      const wavStats = await fs.stat(wavFile);
      
      if (wavStats.size === 0) {
        console.error(`Converted WAV file is empty: ${wavFile}`);
        return false;
      }
      
      // Validate WAV file format by checking header
      const header = Buffer.alloc(12);
      const fd = await fs.open(wavFile, 'r');
      await fd.read(header, 0, 12, 0);
      await fd.close();
      
      // Check for RIFF header and WAVE format
      const isValidWav = 
        header.toString('ascii', 0, 4) === 'RIFF' && 
        header.toString('ascii', 8, 12) === 'WAVE';
      
      if (!isValidWav) {
        console.error(`Invalid WAV format in ${wavFile}`);
        return false;
      }
      
      console.log(`Successfully converted ${mp3File} to WAV`);
      return true;
    } catch (err) {
      console.error(`WAV file validation failed: ${err.message}`);
      return false;
    }
  } catch (error) {
    console.error(`FFmpeg conversion failed: ${error.message}`);
    return false;
  }
};


// Add this to your startup initialization code
async function checkRhubarbBinary() {
  const rhubarbPath = './bin/rhubarb';
  
  try {
    // Check if binary exists
    await fs.access(rhubarbPath);
    console.log('Rhubarb binary found, checking permissions...');
    
    // On Linux/Mac, ensure executable permission
    if (process.platform !== 'win32') {
      try {
        // Check current permissions
        const stats = await fs.stat(rhubarbPath);
        const currentMode = stats.mode;
        
        // Check if executable permission is missing
        if ((currentMode & 0o111) === 0) {
          console.log('Adding executable permission to Rhubarb binary');
          await fs.chmod(rhubarbPath, currentMode | 0o111);
        }
        
        // Test execution
        await execCommandWithTimeout(`${rhubarbPath} --version`, 2000);
        console.log('Rhubarb binary is executable and working');
      } catch (error) {
        console.error(`Error with Rhubarb permissions: ${error.message}`);
        
        // Try to fix with shell command if possible
        try {
          await execCommandWithTimeout(`chmod +x ${rhubarbPath}`, 1000);
          console.log('Fixed Rhubarb permissions using chmod');
        } catch (chmodError) {
          console.error(`Failed to fix Rhubarb permissions: ${chmodError.message}`);
          throw new Error('Please make Rhubarb binary executable with: chmod +x ./bin/rhubarb');
        }
      }
    }
  } catch (error) {
    console.error(`Rhubarb binary issue: ${error.message}`);
    throw new Error('Rhubarb binary not found or not executable. Please check the ./bin directory');
  }
}

// Add this to your app initialization
(async () => {
  await ensureDirectoryExists('audios');
  await ensureDirectoryExists('cache');
  
  // Check Rhubarb binary
  try {
    await checkRhubarbBinary();
  } catch (error) {
    console.error(`WARNING: ${error.message}`);
    console.warn('Lip-sync generation may fail without proper Rhubarb setup');
  }
  
  // Rest of your initialization code...
})();

// Create fallback lipsync data with duration estimation
const createFallbackLipSync = async (jsonFile, audioFile = null) => {
  let duration = 5; // Default duration
  
  // Try to estimate duration from audio file if available
  if (audioFile) {
    try {
      const durationOutput = await execCommandWithTimeout(
        `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${audioFile}"`,
        2000
      );
      const estimatedDuration = parseFloat(durationOutput.trim());
      if (!isNaN(estimatedDuration) && estimatedDuration > 0) {
        duration = estimatedDuration;
      }
    } catch (error) {
      // Use default duration on error
    }
  }
  
  const fallbackData = {
    "metadata": {"version": 1},
    "mouthCues": [
      {"start": 0, "end": duration * 0.25, "value": "X"},
      {"start": duration * 0.25, "end": duration * 0.5, "value": "A"},
      {"start": duration * 0.5, "end": duration * 0.75, "value": "O"},
      {"start": duration * 0.75, "end": duration, "value": "X"}
    ]
  };
  
  await fs.writeFile(jsonFile, JSON.stringify(fallbackData), 'utf8');
  
  // Verify file was created
  try {
    await fs.access(jsonFile);
    return true;
  } catch (error) {
    console.error(`Failed to create fallback lipsync file: ${error.message}`);
    return false;
  }
};

// Check if audio exists in cache with improved validation
const getAudioFromCache = async (text) => {
  const hash = getTextHash(text);
  const cacheFile = `cache/${hash}`;
  
  // Check memory cache first (fastest)
  if (audioCache.has(hash)) {
    const cachedData = audioCache.get(hash);
    // Verify cached files still exist
    try {
      await Promise.all([
        fs.access(cachedData.audioFile),
        fs.access(cachedData.lipsyncFile)
      ]);
      return cachedData;
    } catch {
      // Files no longer exist, remove from memory cache
      audioCache.delete(hash);
    }
  }
  
  try {
    // Check if both audio and lipsync files exist in file cache
    await Promise.all([
      fs.access(`${cacheFile}.mp3`),
      fs.access(`${cacheFile}.json`)
    ]);
    
    // Validate lipsync file format
    try {
      const lipsyncData = await fs.readFile(`${cacheFile}.json`, 'utf8');
      const json = JSON.parse(lipsyncData);
      
      // Basic validation of lipsync data
      if (!json || !json.mouthCues || json.mouthCues.length === 0) {
        throw new Error("Invalid lipsync data");
      }
      
      // Return cached files if they exist and are valid
      const result = {
        audioFile: `${cacheFile}.mp3`,
        lipsyncFile: `${cacheFile}.json`,
        cached: true
      };
      
      // Store in memory cache
      audioCache.set(hash, result);
      
      return result;
    } catch (error) {
      console.warn(`Cached lipsync file is invalid: ${error.message}`);
      // Will regenerate both files
    }
  } catch {
    // Cache miss or files incomplete
  }
  
  return { cached: false, hash, cacheFile };
};

// Process a single message with enhanced reliability for lipsync
const processMessage = async (message, sessionId, index) => {
  const textInput = message.text;
  if (!textInput) {
    return {
      ...message,
      audio: "",
      lipsync: {"metadata":{"version":1},"mouthCues":[{"start":0,"end":5,"value":"X"}]}
    };
  }
  
  // Check cache first
  const cacheResult = await getAudioFromCache(textInput);
  let audioFilePath, lipsyncFilePath;
  
  if (cacheResult.cached) {
    // Use cached files
    audioFilePath = cacheResult.audioFile;
    lipsyncFilePath = cacheResult.lipsyncFile;
    console.log(`Using cached audio and lipsync for message ${index}`);
  } else {
    // Generate new files
    const hash = cacheResult.hash;
    const cacheFile = cacheResult.cacheFile;
    audioFilePath = `audios/message_${sessionId}_${index}.mp3`;
    const wavFilePath = `audios/message_${sessionId}_${index}.wav`;
    lipsyncFilePath = `audios/message_${sessionId}_${index}.json`;
    
    try {
      // Generate audio
      await elevenLabs.textToSpeech({
        voiceId: voiceID,
        fileName: audioFilePath,
        textInput: textInput,
        stability: 0.5,
        similarityBoost: 0.75
      });
      
      // Verify audio file exists
      try {
        await fs.access(audioFilePath);
      } catch (err) {
        throw new Error(`Audio file not generated: ${err.message}`);
      }
      
      // Convert to WAV for lipsync processing
      const conversionSuccess = await convertMp3ToWav(audioFilePath, wavFilePath);
      let lipsyncSuccess = false;
      
      if (conversionSuccess) {
        // Generate lipsync with proper error handling
        lipsyncSuccess = await generateLipSync(wavFilePath, lipsyncFilePath);
        
        // Verify lipsync file was created and is valid
        if (lipsyncSuccess) {
          try {
            const data = await fs.readFile(lipsyncFilePath, 'utf8');
            JSON.parse(data); // Test if valid JSON
          } catch (err) {
            console.warn(`Lipsync file invalid: ${err.message}`);
            lipsyncSuccess = false;
          }
        }
      }
      
      // Create fallback lipsync if needed
      if (!lipsyncSuccess) {
        console.log(`Creating fallback lipsync for message ${index}`);
        await createFallbackLipSync(lipsyncFilePath, audioFilePath);
      }
      
      // Cache the results for future use - only if both files exist
      try {
        await Promise.all([
          fs.access(audioFilePath),
          fs.access(lipsyncFilePath)
        ]);
        
        await Promise.all([
          fs.copyFile(audioFilePath, `${cacheFile}.mp3`),
          fs.copyFile(lipsyncFilePath, `${cacheFile}.json`)
        ]);
        
        console.log(`Successfully cached files for message ${index}`);
      } catch (cacheError) {
        console.error(`Failed to cache files: ${cacheError.message}`);
      }
    } catch (error) {
      console.error(`Error processing message ${index}:`, error);
      
      // Create fallback audio if needed
      try {
        await fs.access(audioFilePath);
      } catch {
        // Generate an empty audio file as a last resort
        try {
          await execCommandWithTimeout(
            `ffmpeg -y -f lavfi -i anullsrc=r=16000:cl=mono -t 3 "${audioFilePath}"`, 
            2000
          );
        } catch (ffmpegError) {
          console.error(`Failed to create empty audio: ${ffmpegError.message}`);
        }
      }
      
      // Create fallback lipsync
      await createFallbackLipSync(lipsyncFilePath, audioFilePath);
      
      // Try to read files, but return fallbacks if not possible
      try {
        await Promise.all([
          fs.access(audioFilePath),
          fs.access(lipsyncFilePath)
        ]);
      } catch {
        return {
          ...message,
          audio: "",
          lipsync: {"metadata":{"version":1},"mouthCues":[{"start":0,"end":5,"value":"X"}]}
        };
      }
    }
  }
  
  // Read audio and lipsync data with robust error handling
  let audio = "";
  let lipsync = {"metadata":{"version":1},"mouthCues":[{"start":0,"end":5,"value":"X"}]};
  
  try {
    audio = await readFileAsStream(audioFilePath);
  } catch (error) {
    console.error(`Failed to read audio file: ${error.message}`);
  }
  
  try {
    const lipsyncData = await fs.readFile(lipsyncFilePath, "utf8");
    lipsync = JSON.parse(lipsyncData);
  } catch (error) {
    console.error(`Failed to read lipsync file: ${error.message}`);
    // Create a new fallback file immediately
    await createFallbackLipSync(lipsyncFilePath, audioFilePath);
    
    try {
      const fallbackData = await fs.readFile(lipsyncFilePath, "utf8");
      lipsync = JSON.parse(fallbackData);
    } catch {
      // Use the default fallback
    }
  }
  
  return {
    ...message,
    audio,
    lipsync
  };
};

// Process multiple messages with batching to avoid overwhelming the system
async function processMessagesWithBatching(messages, sessionId) {
  const batchSize = 2; // Process 2 messages at a time
  const processedMessages = [];
  
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchPromises = batch.map((message, batchIndex) => 
      processMessage(message, sessionId, i + batchIndex)
        .catch(error => {
          console.error(`Failed to process message ${i + batchIndex}:`, error);
          return {
            ...message,
            audio: "",
            lipsync: {"metadata":{"version":1},"mouthCues":[{"start":0,"end":5,"value":"X"}]}
          };
        })
    );
    
    const batchResults = await Promise.all(batchPromises);
    processedMessages.push(...batchResults);
    
    // Small delay between batches to avoid ElevenLabs rate limiting
    if (i + batchSize < messages.length) {
      await new Promise(resolve => setTimeout(resolve, 300));
    }
  }
  
  return processedMessages;
}

// Optimized LLM request with caching
async function getLlamaResponse(userMessage) {
  // Check cache first
  const cacheKey = getRequestHash(userMessage);
  if (llamaResponseCache.has(cacheKey)) {
    return llamaResponseCache.get(cacheKey);
  }
  
  try {
    // Make API request to Llama with a shorter timeout
    const llamaResponse = await axios.post(
      llamaApiUrl,
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          {
            role: "system",
            content: `You are a virtual girlfriend.
              You will always reply with a JSON array of messages. With a maximum of 3 messages.
              Each message has a text, facialExpression, and animation property.
              The different facial expressions are: smile, sad, angry, surprised, funnyFace, and default.
              The different animations are: talking_0, talking_1, talking_2, idle, laughing_slowly, silly_dance, telling_secret.`
          },
          {
            role: "user",
            content: userMessage || "Hello"
          }
        ],
        max_tokens: 800, // Reduced for faster response
        temperature: 0.6,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          "Authorization": `Bearer ${llamaApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 7000 // Reduced timeout for faster failure
      }
    );
    
    let messages;
    try {
      const responseContent = llamaResponse.data.choices?.[0]?.message?.content || "{}";
      const parsedContent = JSON.parse(responseContent);
      
      messages = parsedContent.messages || parsedContent;
      
      if (!Array.isArray(messages)) {
        messages = [messages];
      }
      
      // Limit to a maximum of 3 messages
      messages = messages.slice(0, 3);
      
      // Cache the result
      llamaResponseCache.set(cacheKey, messages);
      
      // Trim cache if too large
      if (llamaResponseCache.size > MAX_CACHE_SIZE) {
        const oldestKey = llamaResponseCache.keys().next().value;
        llamaResponseCache.delete(oldestKey);
      }
      
      return messages;
    } catch (error) {
      console.error("Error parsing Llama response:", error);
      const fallbackMessage = [
        {
          text: "I'm having trouble understanding right now. Could you ask me something else?",
          facialExpression: "sad",
          animation: "idle",
        },
      ];
      
      // Cache the fallback for this problematic request
      llamaResponseCache.set(cacheKey, fallbackMessage);
      
      return fallbackMessage;
    }
  } catch (error) {
    console.error("Error in Llama request:", error);
    return [
      {
        text: "I'm having trouble connecting right now. Could you try again?",
        facialExpression: "sad",
        animation: "idle",
      },
    ];
  }
}

// Optimized route handling
app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/voices", async (req, res) => {
  try {
    // Check cache first
    if (staticFileCache.has('voices')) {
      return res.send(staticFileCache.get('voices'));
    }
    
    const voices = await elevenLabs.getVoices();
    // Cache the result
    staticFileCache.set('voices', voices);
    res.send(voices);
  } catch (error) {
    console.error("Error fetching voices:", error);
    res.status(500).send({ error: "Failed to fetch voices" });
  }
});

// Disable response caching if causing issues with lipsync
const USE_RESPONSE_CACHE = false;
const validateLipsyncData = (lipsync) => {
  // First check if object exists
  if (!lipsync) return false;
  
  try {
    // Check if metadata and mouthCues exist
    if (!lipsync.metadata || !lipsync.mouthCues) return false;
    
    // Check if mouthCues is an array with at least one item
    if (!Array.isArray(lipsync.mouthCues) || lipsync.mouthCues.length === 0) return false;
    
    // Check if each mouth cue has required properties
    for (const cue of lipsync.mouthCues) {
      if (
        typeof cue.start !== 'number' || 
        typeof cue.end !== 'number' || 
        typeof cue.value !== 'string' ||
        cue.start >= cue.end
      ) {
        return false;
      }
    }
    
    return true;
  } catch (error) {
    return false;
  }
};
// Main chat endpoint with request caching
app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  const sessionId = new Date().getTime();
  
  // Check if request is in cache and caching is enabled
  if (USE_RESPONSE_CACHE) {
    const requestHash = getRequestHash(userMessage);
    if (responseCache.has(requestHash)) {
      return res.send(responseCache.get(requestHash));
    }
  }
  
  // Handle empty message case with preloaded response
  if (!userMessage) {
    if (PRELOADED_RESPONSES.emptyMessage) {
      return res.send(PRELOADED_RESPONSES.emptyMessage);
    }
    
    try {
      const [audio, lipsync] = await Promise.all([
        readFileAsStream("audios/ElevenLabs_2025-03-08T03_59_21_Bill_pre_s50_sb75_se0_b_m2.wav"),
        fs.readFile("audios/intro_0.json", "utf8").then(JSON.parse)
      ]);
      
      const response = {
        messages: [
          {
            text: "Hey dear... How was your day?",
            audio: audio,
            lipsync: lipsync,
            facialExpression: "smile",
            animation: "talking_1",
          },
        ],
      };
      
      // Cache for future use if enabled
      if (USE_RESPONSE_CACHE) {
        responseCache.set(getRequestHash(userMessage), response);
      }
      
      res.send(response);
    } catch (error) {
      console.error("Error loading intro files:", error);
      res.send({
        messages: [
          {
            text: "Hey dear... How was your day?",
            facialExpression: "smile",
            animation: "talking_1",
          },
        ],
      });
    }
    return;
  }
  
  // Handle missing API keys case
  if (!elevenLabsApiKey || !llamaApiKey) {
    if (PRELOADED_RESPONSES.noApiKeys) {
      return res.send(PRELOADED_RESPONSES.noApiKeys);
    }
    
    try {
      const [audio0, lipsync0, audio1, lipsync1] = await Promise.all([
        readFileAsStream("audios/api_0.wav"),
        fs.readFile("audios/api_0.json", "utf8").then(JSON.parse),
        readFileAsStream("audios/api_1.wav"),
        fs.readFile("audios/api_1.json", "utf8").then(JSON.parse)
      ]);
      
      const response = {
        messages: [
          {
            text: "Please my dear, don't forget to add your API keys!",
            audio: audio0,
            lipsync: lipsync0,
            facialExpression: "angry",
            animation: "talking_2",
          },
          {
            text: "You don't want to ruin Wawa Sensei with a crazy Llama and ElevenLabs bill, right?",
            audio: audio1,
            lipsync: lipsync1,
            facialExpression: "smile",
            animation: "laughing_slowly",
          },
        ],
      };
      
      res.send(response);
    } catch (error) {
      console.error("Error loading API key warning files:", error);
      res.status(500).send({ error: "Failed to load static files" });
    }
    return;
  }

  try {
    // Get LLM response
    const messages = await getLlamaResponse(userMessage);
    
    // Process messages with more reliable batching
    const processedMessages = await processMessagesWithBatching(messages, sessionId);
    
    // Add a direct function to validate lip-sync results before sending
    const validateLipsyncData = (lipsync) => {
      // First check if object exists
      if (!lipsync) return false;
      
      try {
        // Check if metadata and mouthCues exist
        if (!lipsync.metadata || !lipsync.mouthCues) return false;
        
        // Check if mouthCues is an array with at least one item
        if (!Array.isArray(lipsync.mouthCues) || lipsync.mouthCues.length === 0) return false;
        
        // Check if each mouth cue has required properties
        for (const cue of lipsync.mouthCues) {
          if (
            typeof cue.start !== 'number' || 
            typeof cue.end !== 'number' || 
            typeof cue.value !== 'string' ||
            cue.start >= cue.end
          ) {
            return false;
          }
        }
        
        return true;
      } catch (error) {
        return false;
      }
    };
    
    // Verify all messages have lipsync data before sending
    for (let i = 0; i < processedMessages.length; i++) {
      const message = processedMessages[i];
      
      // Comprehensive validation of lipsync data
      if (!validateLipsyncData(message.lipsync)) {
        console.log(`Message ${i} has invalid lipsync, generating reliable fallback`);
        
        // Duration estimate based on text length if audio is missing
        const textLength = message.text?.length || 10;
        const estimatedDuration = Math.max(3, Math.min(10, textLength * 0.06)); // ~60ms per character
        
        message.lipsync = {
          "metadata": {"version": 1},
          "mouthCues": [
            {"start": 0, "end": estimatedDuration * 0.25, "value": "X"},
            {"start": estimatedDuration * 0.25, "end": estimatedDuration * 0.5, "value": "A"},
            {"start": estimatedDuration * 0.5, "end": estimatedDuration * 0.75, "value": "O"},
            {"start": estimatedDuration * 0.75, "end": estimatedDuration, "value": "X"}
          ]
        };
      }
      
      // Also make sure audio is at least an empty string, not undefined
      if (message.audio === undefined) {
        message.audio = "";
      }
    }
    
    const response = { messages: processedMessages };
    
    // Cache successful responses if enabled
    if (USE_RESPONSE_CACHE) {
      const requestHash = getRequestHash(userMessage);
      responseCache.set(requestHash, response);
      
      // Trim cache if too large
      if (responseCache.size > MAX_CACHE_SIZE) {
        const oldestKey = responseCache.keys().next().value;
        responseCache.delete(oldestKey);
      }
    }
    
    // Final validation before sending
    try {
      // Test if response can be stringified (will catch circular references)
      JSON.stringify(response);
      res.send(response);
    } catch (jsonError) {
      console.error("Response contains unstringifiable data:", jsonError);
      res.status(500).send(PRELOADED_RESPONSES.error || {
        messages: [{
          text: "I'm sorry, there was an error preparing my response. Can we try again?",
          facialExpression: "sad",
          animation: "silly_dance",
        }]
      });
    }
  } catch (error) {
    console.error("Error in request:", error);
    
    if (PRELOADED_RESPONSES.error) {
      res.status(500).send(PRELOADED_RESPONSES.error);
    } else {
      res.status(500).send({
        messages: [
          {
            text: "I'm sorry, there was an error connecting to my brain. Can we try again?",
            facialExpression: "sad",
            animation: "silly_dance",
          },
        ],
      });
    }
  }
});

// Improved cleanup function with batch processing
const cleanupOldFiles = async () => {
  try {
    const [audioFiles, cacheFiles] = await Promise.all([
      fs.readdir('audios'),
      fs.readdir('cache')
    ]);
    
    const now = new Date().getTime();
    const oneHourAgo = now - (60 * 60 * 1000);
    const oneDayAgo = now - CACHE_DURATION;
    
    // Process audio directory cleanup
    const audioFilesToDelete = audioFiles.filter(file => 
      file.startsWith('message_') && 
      !file.includes('intro') && 
      !file.includes('api')
    );
    
    // Process deletions in larger batches for better performance
    const batchSize = 20;
    for (let i = 0; i < audioFilesToDelete.length; i += batchSize) {
      const batch = audioFilesToDelete.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        const filePath = path.join('audios', file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < oneHourAgo) {
            await fs.unlink(filePath);
          }
        } catch (error) {
          // Ignore errors for individual files
        }
      }));
    }
    
    // Clean cache directory with larger batches
    for (let i = 0; i < cacheFiles.length; i += batchSize) {
      const batch = cacheFiles.slice(i, i + batchSize);
      
      await Promise.all(batch.map(async (file) => {
        const filePath = path.join('cache', file);
        try {
          const stats = await fs.stat(filePath);
          if (stats.mtimeMs < oneDayAgo) {
            await fs.unlink(filePath);
          }
        } catch (error) {
          // Ignore errors for individual files
        }
      }));
    }
    
    // Clean in-memory caches periodically
    if (audioCache.size > MAX_CACHE_SIZE * 0.8) {
      const keysToRemove = [...audioCache.keys()].slice(0, MAX_CACHE_SIZE * 0.2);
      keysToRemove.forEach(key => audioCache.delete(key));
    }
    
    if (responseCache.size > MAX_CACHE_SIZE * 0.8) {
      const keysToRemove = [...responseCache.keys()].slice(0, MAX_CACHE_SIZE * 0.2);
      keysToRemove.forEach(key => responseCache.delete(key));
    }
    
    if (llamaResponseCache.size > MAX_CACHE_SIZE * 0.8) {
      const keysToRemove = [...llamaResponseCache.keys()].slice(0, MAX_CACHE_SIZE * 0.2);
      keysToRemove.forEach(key => llamaResponseCache.delete(key));
    }
    
  } catch (error) {
    console.error('Error during file cleanup:', error);
  }
};

// Run cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

// Process level error handling with more detail for debugging
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error.stack || error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason?.stack || reason);
});

// Start server with health check output
app.listen(port, () => {
  console.log(`Study Buddy listening on port ${port} - optimized version running`);
  
  // Log memory usage
  const memUsage = process.memoryUsage();
  console.log(`Memory usage: ${Math.round(memUsage.rss / 1024 / 1024)}MB RSS, ${Math.round(memUsage.heapUsed / 1024 / 1024)}MB Heap`);
});