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
    console.error("CRITICAL ERROR: Missing API Keys in .env file");
    process.exit(1);
}

const deepgram = createClient(process.env.DEEPGRAM_API_KEY);
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// Using 1.5-flash for maximum speed on turn-taking decisions
const geminiModel = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

function log(label, message) {
    const timestamp = new Date().toLocaleTimeString('en-US', { hour12: false, fractionalSecondDigits: 3 });
    console.log(`${timestamp} [${label}] ${message}`);
}

app.use(express.static("public"));

// --- TURN DETECTION HELPER ---
async function getTurnDecision(history, currentBuffer) {
    const prompt = `
    You are an AI turn-taking assistant for a job interview.
    Recent History: ${history.slice(-3).map(m => `${m.role}: ${m.text}`).join(" | ")}
    Current User Input: "${currentBuffer}"

    Decision Rules:
    - Return "complete" if the user has finished their answer, asked a question, or said something like "that's it" or "I'm done".
    - Return "thinking" if the user ends with "and...", "so...", "um", or sounds like they are pausing to recall information.

    Response: [complete/thinking]`;

    try {
        const result = await geminiModel.generateContent(prompt);
        const decision = result.response.text().toLowerCase().trim();
        return decision.includes("complete") ? "complete" : "thinking";
    } catch (e) {
        log("VAD_ERROR", e.message);
        return "thinking"; // Fallback to longer wait
    }
}

wss.on("connection", (ws) => {
    log("SERVER", "Client connected");

    let deepgramLive = null;
    let deepgramTTS = null;
    let ttsSocketOpen = false;
    let keepAliveInterval = null;
    let activeResponseId = 0; 
    
    let transcriptBuffer = "";
    let transcriptTimer = null;
    let conversationHistory = []; // Tracks context for the LLM

    const system_prompt = `
    You are a professional job interviewer.
    YOUR TASK: Conduct a structured interview for an AI Developer position.
    RULES:
    - Respond in one paragraph, under 60 words.
    - Ask one creative question at a time.
    - Never stop asking questions until asked to end.
    - Gradually increase complexity.
    - Do not repeat questions or cross-examine.
    - Stay in character. Do not answer off-topic questions.
    `;

    let chatSession = geminiModel.startChat({
        history: [
            { role: "user", parts: [{ text: system_prompt }] },
            { role: "model", parts: [{ text: "Understood. I am ready to begin the interview." }] },
        ],
    });

    // --- STT SETUP ---
    const setupSTT = () => {
        deepgramLive = deepgram.listen.live({
            model: "nova-3",
            language: "en-IN",
            smart_format: true,
            interim_results: true, 
            encoding: "linear16",
            sample_rate: 16000, 
        });

        deepgramLive.on(LiveTranscriptionEvents.Open, () => {
            log("STT", "Deepgram Live Connected");
            keepAliveInterval = setInterval(() => {
                if (deepgramLive?.getReadyState() === 1) {
                    deepgramLive.send(JSON.stringify({ type: "KeepAlive" }));
                }
            }, 3000);
        });

        deepgramLive.on(LiveTranscriptionEvents.Transcript, async (data) => {
            const transcript = data.channel.alternatives[0].transcript;

            if (transcript && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "transcript", text: transcript, isFinal: data.is_final, sender: "user" }));
            }

            if (data.is_final && transcript.trim().length > 0) {
                if (transcriptTimer) clearTimeout(transcriptTimer);

                transcriptBuffer += " " + transcript;
                const currentText = transcriptBuffer.trim();

                // LLM-BASED TURN DETECTION
                getTurnDecision(conversationHistory, currentText).then((status) => {
                    // Guard: If user spoke again during LLM processing, ignore this decision
                    if (transcriptBuffer.trim() !== currentText) return;

                    const waitTime = (status === "complete") ? 2000 : 4000;
                    log("VAD", `Status: ${status.toUpperCase()} -> Waiting ${waitTime}ms`);

                    if (transcriptTimer) clearTimeout(transcriptTimer);
                    transcriptTimer = setTimeout(async () => {
                        const finalText = transcriptBuffer.trim();
                        transcriptBuffer = ""; 
                        conversationHistory.push({ role: "user", text: finalText });
                        
                        log("STT", `Processing Final: "${finalText}"`);
                        await generateResponse(finalText);
                    }, waitTime);
                });
            }
        });

        deepgramLive.on(LiveTranscriptionEvents.Error, (err) => log("STT_ERROR", err.message));
    };

    // --- TTS SETUP (With Aggregation for Smoothness) ---
    const setupTTS = async () => {
        if (deepgramTTS && ttsSocketOpen) return;

        deepgramTTS = deepgram.speak.live({ 
            model: "aura-2-thalia-en", 
            encoding: "linear16", 
            sample_rate: 16000 
        });

        let audioAggregationBuffer = Buffer.alloc(0);
        const MIN_SEND_SIZE = 1280 * 4; // ~160ms of audio

        return new Promise((resolve) => {
            deepgramTTS.on(LiveTTSEvents.Open, () => { 
                ttsSocketOpen = true; 
                log("TTS", "Socket Opened");
                resolve(); 
            });

            deepgramTTS.on(LiveTTSEvents.Audio, (data) => {
                audioAggregationBuffer = Buffer.concat([audioAggregationBuffer, Buffer.from(data)]);

                if (audioAggregationBuffer.length >= MIN_SEND_SIZE) {
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ 
                            type: "audio", 
                            data: audioAggregationBuffer.toString("base64") 
                        }));
                        log("TTS_SEND", `${audioAggregationBuffer.length} bytes aggregated`);
                    }
                    audioAggregationBuffer = Buffer.alloc(0);
                }
            });

            deepgramTTS.on(LiveTTSEvents.Close, () => { ttsSocketOpen = false; });
            deepgramTTS.on(LiveTTSEvents.Error, (err) => log("TTS_ERROR", err));
        });
    };

    // --- RESPONSE GENERATION ---
    const generateResponse = async (text) => {
        const currentId = ++activeResponseId;
        ws.send(JSON.stringify({ type: "status", text: "Interviewing..." }));

        let fullAiText = "";

        try {
            await setupTTS(); 
            const result = await chatSession.sendMessageStream(text);
            
            for await (const chunk of result.stream) {
                if (activeResponseId !== currentId) return; // Handle interrupts

                const txt = chunk.text();
                if (txt && ttsSocketOpen) {
                    fullAiText += txt;
                    deepgramTTS.sendText(txt);
                    ws.send(JSON.stringify({ type: "transcript", text: txt, sender: "ai", isFinal: false }));
                }
            }
            
            if (activeResponseId === currentId && ttsSocketOpen) {
                conversationHistory.push({ role: "model", text: fullAiText });
                deepgramTTS.flush();
                ws.send(JSON.stringify({ type: "response_complete" })); 
            }
        } catch (e) {
            log("GEN_ERROR", e.message);
        }
    };

    setupSTT();
    // Initial greeting
    setTimeout(() => generateResponse("Hello, let's start the interview."), 500);

    ws.on("message", (message) => {
        let parsed = null;
        try { parsed = JSON.parse(message); } catch(e) {}

        if (parsed?.type === "interrupt_signal") {
            log("SERVER", ">> USER INTERRUPT <<");
            activeResponseId++; 
            if (deepgramTTS) deepgramTTS.flush(); 
            if (transcriptTimer) clearTimeout(transcriptTimer);
            transcriptBuffer = "";
            return;
        }

        if (deepgramLive?.getReadyState() === 1 && !parsed) {
            deepgramLive.send(message);
        }
    });

    ws.on("close", () => {
        log("SERVER", "Client disconnected");
        clearInterval(keepAliveInterval);
        if (transcriptTimer) clearTimeout(transcriptTimer);
        if (deepgramLive) deepgramLive.finish();
        deepgramTTS = null; 
    });
});

server.listen(3000, () => console.log("Interview Server running on http://localhost:3000"));