import asyncio
import base64
import json
import os
from contextlib import asynccontextmanager
from datetime import datetime, timezone

from dotenv import load_dotenv
from fastapi import Depends, FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from google import genai
from google.genai import types
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from .database import Base, engine, get_db
from .models import Transcription
from .schemas import TranscriptionCreate, TranscriptionOut, TranscriptionUpdate

load_dotenv()


@asynccontextmanager
async def lifespan(_: FastAPI):
    Base.metadata.create_all(bind=engine)
    yield


app = FastAPI(title="Procucev Speech-to-Text API", version="1.0.0", lifespan=lifespan)
origins = [x.strip() for x in os.getenv("FRONTEND_ORIGINS", "http://localhost:5173").split(",") if x.strip()]
app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/")
def root():
    return {"name": "Procucev Speech-to-Text API", "docs": "/docs", "health": "/health"}


@app.get("/health")
def health():
    return {"status": "ok", "database": "configured", "speech_provider": "Gemini Live API"}


@app.post("/api/transcriptions", response_model=TranscriptionOut, status_code=201)
def create_transcription(payload: TranscriptionCreate, db: Session = Depends(get_db)):
    item = Transcription(title=payload.title.strip(), transcript=payload.transcript.strip(), language=payload.language)
    db.add(item)
    db.commit()
    db.refresh(item)
    return item


@app.get("/api/transcriptions", response_model=list[TranscriptionOut])
def list_transcriptions(q: str | None = None, db: Session = Depends(get_db)):
    stmt = select(Transcription).order_by(desc(Transcription.created_at))
    items = db.scalars(stmt).all()
    if q and q.strip():
        term = q.casefold().strip()
        items = [x for x in items if term in x.title.casefold() or term in x.transcript.casefold()]
    return items


@app.get("/api/transcriptions/{transcription_id}", response_model=TranscriptionOut)
def get_transcription(transcription_id: int, db: Session = Depends(get_db)):
    item = db.get(Transcription, transcription_id)
    if not item:
        raise HTTPException(status_code=404, detail="Transcription not found")
    return item


@app.put("/api/transcriptions/{transcription_id}", response_model=TranscriptionOut)
def update_transcription(transcription_id: int, payload: TranscriptionUpdate, db: Session = Depends(get_db)):
    item = db.get(Transcription, transcription_id)
    if not item:
        raise HTTPException(status_code=404, detail="Transcription not found")
    values = payload.model_dump(exclude_unset=True)
    for field, value in values.items():
        if isinstance(value, str):
            value = value.strip()
        setattr(item, field, value)
    item.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(item)
    return item


@app.delete("/api/transcriptions/{transcription_id}", status_code=204)
def delete_transcription(transcription_id: int, db: Session = Depends(get_db)):
    item = db.get(Transcription, transcription_id)
    if not item:
        raise HTTPException(status_code=404, detail="Transcription not found")
    db.delete(item)
    db.commit()


@app.websocket("/ws/transcribe")
async def live_transcription(websocket: WebSocket):
    """Browser sends JSON {type:'audio', data:'base64 PCM16 16kHz mono'} messages.
    Server forwards audio to Gemini Live and relays interim/final text events.
    """
    await websocket.accept()
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        await websocket.send_json({"type": "error", "message": "GEMINI_API_KEY is not configured on the server."})
        await websocket.close(code=1011)
        return

    client = genai.Client(api_key=api_key)
    model = os.getenv("GEMINI_LIVE_MODEL", "gemini-3.5-transcribe-live")
    config = types.LiveConnectConfig(
        response_modalities=["TEXT"],
        input_audio_transcription=types.AudioTranscriptionConfig(language_codes=[]),
    )

    try:
        async with client.aio.live.connect(model=model, config=config) as session:
            await websocket.send_json({"type": "ready", "message": "Live transcription connected."})

            async def forward_audio():
                while True:
                    raw = await websocket.receive_text()
                    message = json.loads(raw)
                    if message.get("type") == "stop":
                        await session.send_realtime_input(audio_stream_end=True)
                        # Give the provider a moment to emit the final segment.
                        await asyncio.sleep(1.2)
                        return
                    if message.get("type") != "audio":
                        continue
                    encoded = message.get("data", "")
                    if not encoded:
                        continue
                    chunk = base64.b64decode(encoded)
                    await session.send_realtime_input(
                        audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
                    )

            async def receive_text():
                async for response in session.receive():
                    content = response.server_content
                    if not content:
                        continue
                    interim = getattr(content, "interim_input_transcription", None)
                    final = getattr(content, "input_transcription", None)
                    if interim and getattr(interim, "text", None):
                        await websocket.send_json({"type": "interim", "text": interim.text})
                    if final and getattr(final, "text", None):
                        await websocket.send_json({"type": "final", "text": final.text})

            sender = asyncio.create_task(forward_audio())
            receiver = asyncio.create_task(receive_text())
            done, pending = await asyncio.wait({sender, receiver}, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                error = task.exception()
                if error:
                    raise error
    except WebSocketDisconnect:
        pass
    except asyncio.CancelledError:
        pass
    except Exception as exc:
        try:
            await websocket.send_json({"type": "error", "message": f"Speech service error: {str(exc)[:240]}"})
            await websocket.close(code=1011)
        except Exception:
            pass
