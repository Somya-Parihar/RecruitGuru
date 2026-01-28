require("dotenv").config();
const express = require("express");
const http = require("http");
const WebSocket = require("ws");
const { createClient, LiveTranscriptionEvents, LiveTTSEvents } = require("@deepgram/sdk");
const { GoogleGenerativeAI } = require("@google/generative-ai");

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

if (!process.env.DEEPGRAM_API_KEY || !process.env.GEMINI_API_KEY) {
  console.error("CRITICAL ERROR: Missing API Keys");
  process.exit(1);
}

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });

function log(label, message) {
  console.log(`${new Date().toLocaleTimeString()} [${label}] ${message}`);
}

app.use(express.static("public"));

wss.on("connection", (ws) => {
  log("SERVER", "Client connected");

  let deepgramLive = null;
  let deepgramTTS = null;
  let ttsSocketOpen = false;
  let keepAliveInterval = null;
  let activeResponseId = 0; 
  
  // --- STATE ---
  let transcriptBuffer = "";
  let transcriptTimer = null;

  let chatSession = geminiModel.startChat({
    history: [
      { role: "user", parts: [{ text: "You are voice assistant. make every response 5 sentences" }] },
      { role: "model", parts: [{ text: "Understood." }] },
    ],
  });

  const setupSTT = () => {
    deepgramLive = deepgram.listen.live({
      model: "nova-2",
      language: "en-IN",
      smart_format: true,
      interim_results: true, 
      utterance_end_ms: 5000, 
      endpointing: false, 
      vad_events: true,
      encoding: "linear16",
      sample_rate: 16000, 
    });

    deepgramLive.on(LiveTranscriptionEvents.Open, () => {
        log("STT", "Connected");
        keepAliveInterval = setInterval(() => {
            if (deepgramLive && deepgramLive.getReadyState() === 1) {
                deepgramLive.send(JSON.stringify({ type: "KeepAlive" }));
            }
        }, 3000);
    });
    
    deepgramLive.on(LiveTranscriptionEvents.Transcript, (data) => {
      const transcript = data.channel.alternatives[0].transcript;

      if (transcript && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "transcript", text: transcript, isFinal: data.is_final, sender: "user" }));
      }

      if (data.is_final && transcript.trim().length > 0) {
        
        if (transcriptTimer) clearTimeout(transcriptTimer);

        transcriptBuffer += " " + transcript;

        // --- PATIENT WAIT LOGIC ---
        const wordCount = transcriptBuffer.trim().split(" ").length;
        let waitTime = 15000;

        if (wordCount < 20) {
            // Short phrase -> Assume user is thinking -> WAIT 5 SECONDS
            waitTime = 4000; 
        } else {
            // Long sentence -> Likely done -> Wait 1.5s
            waitTime = 1500;
        }

        log("STT", `Buffer: "${transcriptBuffer}" (Waiting ${waitTime}ms)`);

        transcriptTimer = setTimeout(async () => {
            const finalText = transcriptBuffer.trim();
            transcriptBuffer = ""; 
            
            log("STT", `Processing: "${finalText}"`);
            await generateResponse(finalText);
        }, waitTime); 
      }
    });

    deepgramLive.on(LiveTranscriptionEvents.Error, (err) => log("STT_ERROR", err.message));
    deepgramLive.on(LiveTranscriptionEvents.Close, () => clearInterval(keepAliveInterval));
  };

  const setupTTS = async () => {
    if (deepgramTTS && ttsSocketOpen) return;
    deepgramTTS = deepgram.speak.live({ model: "aura-2-delia-en", encoding: "linear16", sample_rate: 16000 });
    return new Promise((resolve) => {
        deepgramTTS.on(LiveTTSEvents.Open, () => { ttsSocketOpen = true; resolve(); });
        deepgramTTS.on(LiveTTSEvents.Audio, (data) => {
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "audio", data: Buffer.from(data).toString("base64") }));
        });
        deepgramTTS.on(LiveTTSEvents.Close, () => ttsSocketOpen = false);
    });
  };

  const generateResponse = async (text) => {
    const currentId = ++activeResponseId;
    ws.send(JSON.stringify({ type: "status", text: "AI Thinking..." }));

    try {
        await setupTTS(); 
        if (!ttsSocketOpen) return;

        const result = await chatSession.sendMessageStream(text);
        
        for await (const chunk of result.stream) {
            if (activeResponseId !== currentId) return; 

            const txt = chunk.text();
            if (txt && ttsSocketOpen) {
                deepgramTTS.sendText(txt);
                ws.send(JSON.stringify({ type: "transcript", text: txt, sender: "ai", isFinal: false }));
            }
        }
        
        if (activeResponseId === currentId && ttsSocketOpen) {
            deepgramTTS.flush();
            ws.send(JSON.stringify({ type: "response_complete" })); 
        }

    } catch (e) {
        log("GEN_ERROR", e.message);
    }
  };

  setupSTT();
  setTimeout(() => generateResponse("Hello!"), 1000);

  ws.on("message", (message) => {
    let parsed = null;
    try { parsed = JSON.parse(message); } catch(e) {}

    if (parsed && parsed.type === "interrupt_signal") {
        log("STT", ">> INTERRUPT <<");
        activeResponseId++; 
        if (deepgramTTS) deepgramTTS.flush(); 
        if (transcriptTimer) clearTimeout(transcriptTimer);
        transcriptBuffer = "";
        return;
    }

    if (deepgramLive && deepgramLive.getReadyState() === 1 && !parsed) {
        deepgramLive.send(message);
    }
  });

  ws.on("close", () => {
    clearInterval(keepAliveInterval);
    if (transcriptTimer) clearTimeout(transcriptTimer);
    if (deepgramLive) deepgramLive.finish();
    if (deepgramTTS) deepgramTTS = null; 
  });
});

server.listen(3000, () => console.log("Server running on http://localhost:3000"));