from datetime import datetime
from pydantic import BaseModel, ConfigDict, Field


class TranscriptionCreate(BaseModel):
    title: str = Field(default="Untitled transcription", min_length=1, max_length=200)
    transcript: str = Field(min_length=1)
    language: str | None = Field(default=None, max_length=80)


class TranscriptionUpdate(BaseModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    transcript: str | None = Field(default=None, min_length=1)
    language: str | None = Field(default=None, max_length=80)


class TranscriptionOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    title: str
    transcript: str
    language: str | None
    created_at: datetime
    updated_at: datetime
