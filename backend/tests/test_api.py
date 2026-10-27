import os

# Use an isolated SQLite file for tests, before importing the application.
os.environ["DATABASE_URL"] = "sqlite:///./test_speech.db"
os.environ["GEMINI_API_KEY"] = "test-key"

from fastapi.testclient import TestClient
from app.main import app


def test_transcription_crud():
    with TestClient(app) as client:
        created = client.post("/api/transcriptions", json={
            "title": "Interview notes",
            "transcript": "Hello, namaste.",
            "language": "Hindi + English"
        })
        assert created.status_code == 201
        item = created.json()
        transcription_id = item["id"]

        fetched = client.get(f"/api/transcriptions/{transcription_id}")
        assert fetched.status_code == 200
        assert fetched.json()["transcript"] == "Hello, namaste."

        updated = client.put(f"/api/transcriptions/{transcription_id}", json={"title": "Updated notes"})
        assert updated.status_code == 200
        assert updated.json()["title"] == "Updated notes"

        listed = client.get("/api/transcriptions?q=updated")
        assert listed.status_code == 200
        assert len(listed.json()) == 1

        deleted = client.delete(f"/api/transcriptions/{transcription_id}")
        assert deleted.status_code == 204
        missing = client.get(f"/api/transcriptions/{transcription_id}")
        assert missing.status_code == 404
