import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import ElevenLabs from "elevenlabs-node";
import express from "express";
import { promises as fs } from "fs";
import axios from "axios";
import path from "path";
import { createHash } from "crypto";
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

// Cache to store previously generated audio
const audioCache = new Map();

// Ensure audios directory exists
async function ensureDirectoryExists(directory) {
  try {
    await fs.access(directory);
  } catch (error) {
    await fs.mkdir(directory, { recursive: true });
    console.log(`Created directory: ${directory}`);
  }
}

// Initialize app
(async () => {
  await ensureDirectoryExists('audios');
  await ensureDirectoryExists('cache');
})();

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/voices", async (req, res) => {
  const voices = await elevenLabs.getVoices();
  res.send(voices);
});

// Generate a hash for text to use as cache key
function getTextHash(text) {
  return createHash('md5').update(text).digest('hex');
}

// Execute command with timeout
const execCommandWithTimeout = (command, timeoutMs = 10000) => {
  return new Promise((resolve, reject) => {
    const process = exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
    
    // Set timeout to kill process if it takes too long
    const timeout = setTimeout(() => {
      process.kill();
      reject(new Error(`Command timed out after ${timeoutMs}ms: ${command}`));
    }, timeoutMs);
    
    // Clear timeout if process finishes
    process.on('exit', () => clearTimeout(timeout));
  });
};

// Optimized lipsync generation
const generateLipSync = async (wavFile, jsonFile) => {
  try {
    await execCommandWithTimeout(
      `./bin/rhubarb -f json -o "${jsonFile}" "${wavFile}" -r phonetic`, 
      8000 // 8 second timeout
    );
    return true;
  } catch (error) {
    console.warn(`Lip sync generation failed: ${error.message}`);
    return false;
  }
};

// Convert mp3 to wav
const convertMp3ToWav = async (mp3File, wavFile) => {
  try {
    await execCommandWithTimeout(`ffmpeg -y -i "${mp3File}" "${wavFile}"`, 5000);
    return true;
  } catch (error) {
    console.error(`FFmpeg conversion failed: ${error.message}`);
    return false;
  }
};

// Create fallback lipsync data
const createFallbackLipSync = async (jsonFile, duration = 5) => {
  const fallbackData = {
    "metadata": {"version": 1},
    "mouthCues": [{"start": 0, "end": duration, "value": "X"}]
  };
  await fs.writeFile(jsonFile, JSON.stringify(fallbackData), 'utf8');
};

// Check if audio exists in cache
const getAudioFromCache = async (text) => {
  const hash = getTextHash(text);
  const cacheFile = `cache/${hash}`;
  
  try {
    // Check if audio file exists in cache
    await fs.access(`${cacheFile}.mp3`);
    
    // Check if lipsync file exists
    let lipsyncExists = true;
    try {
      await fs.access(`${cacheFile}.json`);
    } catch {
      lipsyncExists = false;
    }
    
    // Return cached files if they exist
    if (lipsyncExists) {
      return {
        audioFile: `${cacheFile}.mp3`,
        lipsyncFile: `${cacheFile}.json`,
        cached: true
      };
    }
  } catch {
    // Cache miss
  }
  
  return { cached: false, hash, cacheFile };
};

// Process a single message with caching
const processMessage = async (message, sessionId, index) => {
  const textInput = message.text;
  
  // Check cache first
  const cacheResult = await getAudioFromCache(textInput);
  let audioFilePath, lipsyncFilePath;
  
  if (cacheResult.cached) {
    // Use cached files
    audioFilePath = cacheResult.audioFile;
    lipsyncFilePath = cacheResult.lipsyncFile;
    console.log(`Using cached audio for message ${index}`);
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
      
      // Convert to WAV and generate lipsync in parallel
      const conversionSuccess = await convertMp3ToWav(audioFilePath, wavFilePath);
      
      if (conversionSuccess) {
        const lipsyncSuccess = await generateLipSync(wavFilePath, lipsyncFilePath);
        
        if (!lipsyncSuccess) {
          await createFallbackLipSync(lipsyncFilePath);
        }
      } else {
        await createFallbackLipSync(lipsyncFilePath);
      }
      
      // Cache the results for future use
      try {
        await fs.copyFile(audioFilePath, `${cacheFile}.mp3`);
        await fs.copyFile(lipsyncFilePath, `${cacheFile}.json`);
      } catch (cacheError) {
        console.error(`Failed to cache files: ${cacheError.message}`);
      }
    } catch (error) {
      console.error(`Error processing message ${index}:`, error);
      // Create fallback files
      await createFallbackLipSync(lipsyncFilePath);
      throw error;
    }
  }
  
  // Read audio and lipsync data
  const [audio, lipsync] = await Promise.all([
    audioFileToBase64(audioFilePath),
    readJsonTranscript(lipsyncFilePath)
  ]);
  
  return {
    ...message,
    audio,
    lipsync
  };
};

// Process multiple messages with optimized batching
async function processMessagesWithBatching(messages, sessionId) {
  // Split messages into batches for better throughput
  const batchSize = 2; // Process 2 messages at a time to avoid rate limits
  const processedMessages = [];
  
  for (let i = 0; i < messages.length; i += batchSize) {
    const batch = messages.slice(i, i + batchSize);
    const batchPromises = batch.map((message, batchIndex) => 
      processMessage(message, sessionId, i + batchIndex)
        .catch(error => {
          // Fallback for errors
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

// Improved caching for static files
const staticFileCache = new Map();

async function getCachedStaticFile(filePath, isBase64 = false) {
  if (!staticFileCache.has(filePath)) {
    try {
      const data = await fs.readFile(filePath, isBase64 ? null : 'utf8');
      const content = isBase64 ? data.toString('base64') : JSON.parse(data);
      staticFileCache.set(filePath, content);
      return content;
    } catch (error) {
      console.error(`Error reading static file ${filePath}:`, error);
      throw error;
    }
  }
  return staticFileCache.get(filePath);
}

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  const sessionId = new Date().getTime();
  
  if (!userMessage) {
    try {
      const [audio, lipsync] = await Promise.all([
        getCachedStaticFile("audios/ElevenLabs_2025-03-08T03_59_21_Bill_pre_s50_sb75_se0_b_m2.wav", true),
        getCachedStaticFile("audios/intro_0.json")
      ]);
      
      res.send({
        messages: [
          {
            text: "Hey dear... How was your day?",
            audio: audio,
            lipsync: lipsync,
            facialExpression: "smile",
            animation: "talking_1",
          },
        ],
      });
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
  
  if (!elevenLabsApiKey || !llamaApiKey) {
    try {
      const [audio0, lipsync0, audio1, lipsync1] = await Promise.all([
        getCachedStaticFile("audios/api_0.wav", true),
        getCachedStaticFile("audios/api_0.json"),
        getCachedStaticFile("audios/api_1.wav", true),
        getCachedStaticFile("audios/api_1.json")
      ]);
      
      res.send({
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
      });
    } catch (error) {
      console.error("Error loading API key warning files:", error);
      res.status(500).send({ error: "Failed to load static files" });
    }
    return;
  }

  try {
    // Make API request to Llama with a timeout
    const llamaRequestPromise = axios.post(
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
        max_tokens: 1000,
        temperature: 0.6,
        response_format: { type: "json_object" }
      },
      {
        headers: {
          "Authorization": `Bearer ${llamaApiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 10000 // 10 second timeout
      }
    );
    
    // Add timeout for Llama API
    const llamaResponse = await llamaRequestPromise;
    
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
    } catch (error) {
      console.error("Error parsing Llama response:", error);
      messages = [
        {
          text: "I'm having trouble understanding right now. Could you ask me something else?",
          facialExpression: "sad",
          animation: "idle",
        },
      ];
    }
    
    // Process messages with batching for faster overall time
    const processedMessages = await processMessagesWithBatching(messages, sessionId);
    
    res.send({ messages: processedMessages });
  } catch (error) {
    console.error("Error in request:", error);
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
});

const readJsonTranscript = async (file) => {
  try {
    const data = await fs.readFile(file, "utf8");
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading transcript file ${file}:`, error);
    return {"metadata":{"version":1},"mouthCues":[{"start":0,"end":5,"value":"X"}]};
  }
};

const audioFileToBase64 = async (file) => {
  try {
    const data = await fs.readFile(file);
    return data.toString("base64");
  } catch (error) {
    console.error(`Error reading audio file ${file}:`, error);
    return ""; // Return empty string on failure
  }
};

// Improved cleanup function
const cleanupOldFiles = async () => {
  try {
    const files = await fs.readdir('audios');
    const now = new Date().getTime();
    const oneHourAgo = now - (60 * 60 * 1000);
    
    const filesToDelete = files.filter(file => 
      file.startsWith('message_') && 
      !file.includes('intro') && 
      !file.includes('api')
    );
    
    // Process deletions in batches to avoid overwhelming the file system
    const batchSize = 10;
    for (let i = 0; i < filesToDelete.length; i += batchSize) {
      const batch = filesToDelete.slice(i, i + batchSize);
      
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
    
    // Clean cache directory periodically - keep only files used in last 24 hours
    const cacheFiles = await fs.readdir('cache');
    const oneDayAgo = now - (24 * 60 * 60 * 1000);
    
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
  } catch (error) {
    console.error('Error during file cleanup:', error);
  }
};

// Run cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

// Process level error handling
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

app.listen(port, () => {
  console.log(`Study Buddy listening on port ${port}`);
});