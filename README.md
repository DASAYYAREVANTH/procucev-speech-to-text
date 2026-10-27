# VoxNote — Procucev Speech-to-Text Assignment

A real-time multilingual speech-to-text MVP with React, FastAPI, Gemini Live API, and PostgreSQL/SQLite. The browser streams mono PCM16 audio at 16 kHz to the FastAPI WebSocket; the backend relays it to Gemini Live and returns interim/final transcript updates. Final text is saved to the database when recording stops.

## Features

- Live transcript updates while speaking
- Automatic language detection (supports multilingual/code-switching, subject to provider capabilities)
- PostgreSQL persistence (SQLite for local quick start)
- CRUD endpoints and dashboard (create, list/search, detail, edit, delete)
- FastAPI Swagger docs at `/docs`
- Basic CRUD API test

## Requirements

- Python 3.11+ (3.12 recommended)
- Node.js 20+ and npm
- Gemini API key with Live API access
- Microphone and a modern browser; production microphone access requires HTTPS

## 1. Backend setup

```bash
cd backend
python -m venv .venv
# Windows PowerShell:
.venv\\Scripts\\Activate.ps1
# macOS/Linux:
source .venv/bin/activate
pip install -r requirements.txt
copy .env.example .env   # Windows; on macOS/Linux use: cp .env.example .env
```

Edit `backend/.env` and set `GEMINI_API_KEY`. SQLite is the default and creates `speech_to_text.db` locally. To use PostgreSQL, set for example:

```env
DATABASE_URL=postgresql+psycopg://postgres:YOUR_PASSWORD@localhost:5432/speechdb
GEMINI_API_KEY=your_key_here
FRONTEND_ORIGINS=http://localhost:5173
GEMINI_LIVE_MODEL=gemini-3.5-transcribe-live
```

Run the API from the `backend` directory:

```bash
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Check `http://localhost:8000/health` and `http://localhost:8000/docs`.

## 2. Frontend setup

In a second terminal:

```bash
cd frontend
npm install
cp .env.example .env
npm run dev
```

On Windows, copy `.env.example` to `.env` using File Explorer or PowerShell `Copy-Item .env.example .env`. Open the Vite URL printed in the terminal, usually `http://localhost:5173`.

If backend runs on another URL, set `VITE_API_BASE_URL` in `frontend/.env`, then restart Vite. After changing frontend environment variables, restart the dev server.

## 3. Test the backend

From the `backend` directory with the virtual environment active:

```bash
pytest -q
```

The included test exercises create, read, search, update, and delete. It does not test live provider connectivity. Test live transcription separately using the dashboard and a valid Gemini API key.

## 4. API endpoints

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/api/transcriptions` | Create transcript |
| GET | `/api/transcriptions?q=term` | List/search transcripts |
| GET | `/api/transcriptions/{id}` | Get one transcript |
| PUT | `/api/transcriptions/{id}` | Update title/transcript/language |
| DELETE | `/api/transcriptions/{id}` | Delete transcript |
| WS | `/ws/transcribe` | Live audio streaming and transcript events |

## 5. GitHub setup

From the project root:

```bash
git init
git add .
git commit -m "Build real-time multilingual speech-to-text MVP"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/procucev-speech-to-text.git
git push -u origin main
```

Create the empty repository on GitHub first. Never commit `.env`, API keys, database passwords, or other secrets. The supplied `.gitignore` excludes `.env` and local databases.

## 6. Deployment outline

### Backend on Render

1. Push the project to GitHub.
2. Create a Render **Web Service** using the `backend` directory as the root directory.
3. Build command: `pip install -r requirements.txt`
4. Start command: `uvicorn app.main:app --host 0.0.0.0 --port $PORT`
5. Add environment variables: `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL`, `DATABASE_URL`, and `FRONTEND_ORIGINS`.
6. Create a managed PostgreSQL database and set `DATABASE_URL` to its internal connection URL. If the service and database are in separate providers, use the provider's external URL and TLS requirements.

### Frontend on Render Static Site

1. Create a Static Site from the same GitHub repository.
2. Set root directory to `frontend`.
3. Build command: `npm install && npm run build`
4. Publish directory: `dist`
5. Set `VITE_API_BASE_URL` to the deployed backend URL, without a trailing slash, then deploy.
6. Update backend `FRONTEND_ORIGINS` to the exact deployed frontend origin (for example `https://your-app.onrender.com`) and redeploy the backend.

Vite environment variables are embedded at build time, so changing `VITE_API_BASE_URL` requires a frontend rebuild/redeploy. Use HTTPS in production so browsers permit microphone access.
