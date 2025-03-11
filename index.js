import { exec } from "child_process";
import cors from "cors";
import dotenv from "dotenv";
import ElevenLabs from "elevenlabs-node"; // Import your local implementation instead
import express from "express";
import { promises as fs } from "fs";
import axios from "axios";
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

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.get("/voices", async (req, res) => {
  // Use the instance method from your ElevenLabs class
  const voices = await elevenLabs.getVoices();
  res.send(voices);
});

const execCommand = (command) => {
  return new Promise((resolve, reject) => {
    exec(command, (error, stdout, stderr) => {
      if (error) reject(error);
      resolve(stdout);
    });
  });
};

const lipSyncMessage = async (sessionId, messageIndex) => {
  const time = new Date().getTime();
  console.log(`Starting conversion for session ${sessionId}, message ${messageIndex}`);
  try {
    await execCommand(
      `ffmpeg -y -i audios/message_${sessionId}_${messageIndex}.mp3 audios/message_${sessionId}_${messageIndex}.wav`
    );
    console.log(`Conversion done in ${new Date().getTime() - time}ms`);
    
    try {
      await execCommand(
        `./bin/rhubarb -f json -o audios/message_${sessionId}_${messageIndex}.json audios/message_${sessionId}_${messageIndex}.wav -r phonetic`
      );
      console.log(`Lip sync done in ${new Date().getTime() - time}ms`);
    } catch (error) {
      console.warn("Lip sync failed, using fallback lip sync data");
      // Create a simple fallback lip sync file
      const fallbackData = {"metadata":{"version":1},"mouthCues":[{"start":0,"end":5,"value":"X"}]};
      await fs.writeFile(`audios/message_${sessionId}_${messageIndex}.json`, JSON.stringify(fallbackData), 'utf8');
    }
  } catch (error) {
    console.error("Audio conversion failed:", error);
    throw error;
  }
};

app.post("/chat", async (req, res) => {
  const userMessage = req.body.message;
  
  // Generate a unique session ID for this request
  const sessionId = new Date().getTime();
  
  if (!userMessage) {
    res.send({
      messages: [
        {
          text: "Hey dear... How was your day?",
          audio: await audioFileToBase64("audios/ElevenLabs_2025-03-08T03_59_21_Bill_pre_s50_sb75_se0_b_m2.wav"),
          lipsync: await readJsonTranscript("audios/intro_0.json"),
          facialExpression: "smile",
          animation: "talking_1",
        },
      ],
    });
    return;
  }
  
  if (!elevenLabsApiKey || !llamaApiKey) {
    res.send({
      messages: [
        {
          text: "Please my dear, don't forget to add your API keys!",
          audio: await audioFileToBase64("audios/api_0.wav"),
          lipsync: await readJsonTranscript("audios/api_0.json"),
          facialExpression: "angry",
          animation: "talking_2",
        },
        {
          text: "You don't want to ruin Wawa Sensei with a crazy Llama and ElevenLabs bill, right?",
          audio: await audioFileToBase64("audios/api_1.wav"),
          lipsync: await readJsonTranscript("audios/api_1.json"),
          facialExpression: "smile",
          animation: "laughing_slowly",
        },
      ],
    });
    return;
  }

  try {
    // Correctly format the request for Groq API
    const llamaResponse = await axios.post(
      llamaApiUrl,
      {
        model: "llama-3.3-70b-versatile", // Adjust based on actual model name
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
      }
    );
    
    let messages;
    try {
      // Handle the correct response format from Groq API
      const responseContent = llamaResponse.data.choices?.[0]?.message?.content || "{}";
      const parsedContent = JSON.parse(responseContent);
      
      messages = parsedContent.messages || parsedContent;
      
      if (!Array.isArray(messages)) {
        messages = [messages]; // Ensure we have an array
      }
    } catch (error) {
      console.error("Error parsing Llama response:", error);
      // Fallback response in case parsing fails
      messages = [
        {
          text: "I'm having trouble understanding right now. Could you ask me something else?",
          facialExpression: "sad",
          animation: "idle",
        },
      ];
    }
    
    for (let i = 0; i < messages.length; i++) {
      const message = messages[i];
      // Use unique filenames with sessionId to prevent overwriting
      const fileName = `audios/message_${sessionId}_${i}.mp3`;
      const textInput = message.text;
      
      // Use the ElevenLabs instance method
      await elevenLabs.textToSpeech({
        voiceId: voiceID,
        fileName: fileName,
        textInput: textInput,
        stability: 0.5,
        similarityBoost: 0.75
      });
      
      // generate lipsync with unique sessionId
      await lipSyncMessage(sessionId, i);
      message.audio = await audioFileToBase64(fileName);
      message.lipsync = await readJsonTranscript(`audios/message_${sessionId}_${i}.json`);
    }

    res.send({ messages });
  } catch (error) {
    console.error("Error calling Llama API:", error);
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
  const data = await fs.readFile(file, "utf8");
  return JSON.parse(data);
};

const audioFileToBase64 = async (file) => {
  const data = await fs.readFile(file);
  return data.toString("base64");
};

// Optional: Add a cleanup function to periodically remove old files
// This helps prevent your disk from filling up with unused audio files
const cleanupOldFiles = async () => {
  try {
    const files = await fs.readdir('audios');
    const now = new Date().getTime();
    const oneHourAgo = now - (60 * 60 * 1000); // 1 hour in milliseconds
    
    for (const file of files) {
      // Only process generated message files, not static files
      if (file.startsWith('message_') && !file.includes('intro') && !file.includes('api')) {
        const filePath = `audios/${file}`;
        const stats = await fs.stat(filePath);
        
        // If file is older than one hour, delete it
        if (stats.mtimeMs < oneHourAgo) {
          await fs.unlink(filePath);
          console.log(`Deleted old file: ${filePath}`);
        }
      }
    }
  } catch (error) {
    console.error('Error during file cleanup:', error);
  }
};

// Run cleanup every hour
setInterval(cleanupOldFiles, 60 * 60 * 1000);

app.listen(port, () => {
  console.log(`Study Buddy listening on port ${port}`);
});