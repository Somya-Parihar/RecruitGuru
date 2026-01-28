import os
import asyncio
import json
import base64
from typing import Dict, Any
from dotenv import load_dotenv

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

from deepgram import (
    DeepgramClient,
    LiveTranscriptionEvents,
    LiveOptions,
    SpeakOptions,
)
import google.generativeai as genai

load_dotenv()

# --- CONFIG ---
DEEPGRAM_API_KEY = os.getenv("DEEPGRAM_API_KEY")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")

if not DEEPGRAM_API_KEY or not GEMINI_API_KEY:
    raise ValueError("Missing API Keys in .env file")

# --- SETUP CLIENTS ---
# Deepgram
deepgram_client = DeepgramClient(DEEPGRAM_API_KEY)

# Gemini
genai.configure(api_key=GEMINI_API_KEY)
# Using Flash for speed
gemini_model = genai.GenerativeModel("gemini-1.5-flash")

app = FastAPI()

# Serve the frontend
app.mount("/public", StaticFiles(directory="public"), name="public")

# Serve index.html at root
@app.get("/")
async def get():
    from fastapi.responses import FileResponse
    return FileResponse('public/index.html')


class VoiceAgent:
    def __init__(self, websocket: WebSocket):
        self.websocket = websocket
        self.dg_connection = None
        self.chat_session = None
        self.active_response_id = 0
        
        # Buffering / Regret Strategy State
        self.transcript_buffer = ""
        self.buffer_task = None
        self.is_llm_processing = False
        self.last_processed_text = ""

    async def start(self):
        await self.websocket.accept()
        print("[SERVER] Client Connected")

        # 1. Init Gemini Chat with System Prompt
        self.chat_session = gemini_model.start_chat(history=[
            {"role": "user", "parts": ["You are a concise voice assistant. Keep answers short."]},
            {"role": "model", "parts": ["Understood. I will be brief."]}
        ])

        # 2. Setup Deepgram STT (Listen)
        self.dg_connection = deepgram_client.listen.asyncwebsocket.v("1")

        # Define Event Handlers
        async def on_message(self_dg, result, **kwargs):
            sentence = result.channel.alternatives[0].transcript
            if not sentence:
                return

            # Send Interim to UI
            await self.websocket.send_json({
                "type": "transcript",
                "text": sentence,
                "isFinal": result.is_final,
                "sender": "user"
            })

            # Process Final
            if result.is_final and len(sentence.strip()) > 0:
                await self.handle_final_transcript(sentence)

        async def on_error(self_dg, error, **kwargs):
            print(f"[STT_ERROR] {error}")

        # Hook up handlers
        self.dg_connection.on(LiveTranscriptionEvents.Transcript, on_message)
        self.dg_connection.on(LiveTranscriptionEvents.Error, on_error)

        # Start Connection
        options = LiveOptions(
            model="nova-2",
            language="en-US",
            smart_format=True,
            interim_results=True,
            utterance_end_ms=1000,
            vad_events=True,
            endpointing=500, # Wait 500ms before cutting
            encoding="linear16",
            sample_rate=16000,
        )
        
        if await self.dg_connection.start(options) is False:
            print("Failed to start Deepgram")
            return

        print("[STT] Connected")

        # 3. Handle Incoming Data from Browser (Audio & Commands)
        try:
            while True:
                # Receive can be bytes (audio) or text (JSON command)
                message = await self.websocket.receive()
                
                if "bytes" in message:
                    # Send Audio to Deepgram
                    await self.dg_connection.send(message["bytes"])
                
                elif "text" in message:
                    try:
                        data = json.loads(message["text"])
                        if data.get("type") == "interrupt_signal":
                            print("[UI] >> INTERRUPT <<")
                            await self.handle_interrupt()
                    except:
                        pass
                        
        except WebSocketDisconnect:
            print("[SERVER] Client Disconnected")
            await self.cleanup()

    async def handle_interrupt(self):
        """Cancels current generation and clears buffers."""
        self.active_response_id += 1
        self.transcript_buffer = ""
        if self.buffer_task:
            self.buffer_task.cancel()
        self.is_llm_processing = False

    async def handle_final_transcript(self, transcript):
        """Implements the Buffering + Regret Strategy"""
        
        # 1. Cancel existing timer if user kept talking
        if self.buffer_task:
            self.buffer_task.cancel()

        # 2. Smart Merge Logic
        if self.is_llm_processing:
            print("[STT] >> MERGE TRIGGERED <<")
            # Cancel current LLM generation
            self.active_response_id += 1
            self.is_llm_processing = False
            # Merge old text + new text
            self.transcript_buffer = f"{self.last_processed_text} {transcript}"
        else:
            self.transcript_buffer += f" {transcript}"

        # 3. Start new timer (Wait 1.5s for more speech)
        self.buffer_task = asyncio.create_task(self.process_buffered_text())

    async def process_buffered_text(self):
        try:
            await asyncio.sleep(1.0) # Buffer Wait Time
            
            final_text = self.transcript_buffer.strip()
            self.transcript_buffer = ""
            self.last_processed_text = final_text
            
            print(f"[STT] Processing: {final_text}")
            await self.generate_response(final_text)
            
        except asyncio.CancelledError:
            pass # Timer was cancelled by new speech or interrupt

    async def generate_response(self, text):
        current_id = self.active_response_id + 1
        self.active_response_id = current_id
        self.is_llm_processing = True

        try:
            # 1. Init Deepgram TTS (REST-based streaming is simpler in Python async)
            #    or use WebSocket. Here we use the requests wrapper for simplicity
            #    streaming back chunks.
            
            # Note: For strict low-latency, Python SDK 'speak.live' is complex.
            # We will use the standard streaming call and stream chunks manually.
            
            response_stream = self.chat_session.send_message_stream(text)

            for chunk in response_stream:
                if self.active_response_id != current_id:
                    print("[LLM] Interrupted.")
                    break
                
                if chunk.text:
                    token = chunk.text
                    # Send text to UI
                    await self.websocket.send_json({
                        "type": "transcript",
                        "text": token,
                        "sender": "ai",
                        "isFinal": False
                    })
                    
                    # Send to Deepgram TTS
                    await self.speak_text(token, current_id)
            
            # Send End of Turn signal
            if self.active_response_id == current_id:
                await self.websocket.send_json({"type": "response_complete"})

        except Exception as e:
            print(f"[GEN_ERROR] {e}")
        finally:
            if self.active_response_id == current_id:
                self.is_llm_processing = False

    async def speak_text(self, text, response_id):
        """Converts text to audio and sends to WS"""
        if self.active_response_id != response_id: return

        try:
            # Deepgram TTS call
            options = SpeakOptions(
                model="aura-asteria-en",
                encoding="linear16",
                sample_rate=24000
            )
            
            # In Python SDK, we can just save to memory or stream. 
            # Ideally we want a persistent WS but for this snippets simplicity:
            res = deepgram_client.speak.v("1").stream(
                {"text": text}, 
                options
            )
            
            # 'res' is a stream object. Read bytes and send.
            # Note: This is blocking IO wrapped in async. For production, 
            # use deepgram-python-sdk async speak clients if available/stable.
            
            # For simplicity in this example script, we read the bytes:
            audio_bytes = res.stream.read() 
            
            if self.active_response_id == response_id:
                 await self.websocket.send_json({
                    "type": "audio",
                    "data": base64.b64encode(audio_bytes).decode('utf-8')
                })

        except Exception as e:
            print(f"[TTS_ERROR] {e}")

    async def cleanup(self):
        if self.dg_connection:
            await self.dg_connection.finish()


@app.websocket_route("/")
async def websocket_endpoint(websocket: WebSocket):
    agent = VoiceAgent(websocket)
    await agent.start()

if __name__ == "__main__":
    import uvicorn
    # Listen on all interfaces so it's easy to test
    uvicorn.run(app, host="0.0.0.0", port=3000)