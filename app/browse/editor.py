from __future__ import annotations

import os
import secrets
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import resolve_safe_path
from app.transfers import db

router = APIRouter(prefix="/api")

# Explicit allowlist of editable text file extensions
ALLOWLISTED_TEXT_EXTENSIONS = {
    ".txt",
    ".md",
    ".conf",
    ".cfg",
    ".ini",
    ".toml",
    ".yaml",
    ".yml",
    ".json",
    ".env",
    ".log",
    ".csv",
    ".py",
    ".sh",
    ".js",
    ".css",
    ".html",
    ".xml",
    ".srt",
}

# Maximum editable file size (2 MB)
MAX_EDITOR_SIZE_BYTES = 2 * 1024 * 1024


class FileEditRequest(BaseModel):
    path: str
    content: str
    expected_mtime_ns: str


def is_allowlisted_text_extension(filename: str) -> bool:
    """Check if file has an allowlisted text extension (case-insensitive)."""
    ext = Path(filename).suffix.lower()
    return ext in ALLOWLISTED_TEXT_EXTENSIONS


@router.get("/file-content")
async def get_file_content(
    path: str,
    _user: str = Depends(get_current_user),
):
    """Retrieve text file content and integer nanosecond mtime for editing.

    Independently enforces the extension allowlist, size cap (2MB), and strict UTF-8 decoding.
    Transmits mtime_ns as an opaque string to prevent loss of precision when parsed by JavaScript Numbers.
    """
    settings = get_settings()
    resolved = resolve_safe_path(path, settings.allowed_roots)

    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    if not is_allowlisted_text_extension(resolved.name):
        raise HTTPException(status_code=400, detail="File type is not supported for editing")

    try:
        stat_result = resolved.stat()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to stat file: {e}")

    if stat_result.st_size > MAX_EDITOR_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File exceeds maximum editable size of {MAX_EDITOR_SIZE_BYTES // (1024 * 1024)} MB",
        )

    try:
        raw_bytes = resolved.read_bytes()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to read file: {e}")

    try:
        text_content = raw_bytes.decode("utf-8")
    except UnicodeDecodeError:
        raise HTTPException(status_code=400, detail="File is not valid UTF-8 text")

    return {
        "content": text_content,
        "mtime_ns": str(stat_result.st_mtime_ns),
        "path": str(resolved),
    }


@router.post("/file-content")
async def save_file_content(
    body: FileEditRequest,
    _user: str = Depends(get_current_user),
):
    """Save updated text content to file safely using atomic replacement and mtime concurrency check."""
    settings = get_settings()
    resolved = resolve_safe_path(body.path, settings.allowed_roots)

    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    if not is_allowlisted_text_extension(resolved.name):
        raise HTTPException(status_code=400, detail="File type is not supported for editing")

    encoded_bytes = body.content.encode("utf-8")
    if len(encoded_bytes) > MAX_EDITOR_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"Content exceeds maximum editable size of {MAX_EDITOR_SIZE_BYTES // (1024 * 1024)} MB",
        )

    try:
        current_stat = resolved.stat()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to stat file: {e}")

    try:
        expected_mtime_int = int(body.expected_mtime_ns)
    except (ValueError, TypeError):
        raise HTTPException(status_code=400, detail="Invalid expected_mtime_ns format")

    # Optimistic concurrency check (integer nanosecond precision)
    if current_stat.st_mtime_ns != expected_mtime_int:
        raise HTTPException(status_code=409, detail="File has been modified since it was opened")

    # Atomic write pattern: write to temporary file in same directory then atomic rename
    parent_dir = resolved.parent
    temp_filename = f".litesync-edit-{secrets.token_hex(8)}.tmp"
    temp_path = parent_dir / temp_filename

    try:
        with open(temp_path, "wb") as f:
            f.write(encoded_bytes)
            f.flush()
            os.fsync(f.fileno())
    except Exception as e:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to write temporary file: {e}")

    try:
        os.rename(temp_path, resolved)
    except OSError as e:
        temp_path.unlink(missing_ok=True)
        raise HTTPException(status_code=500, detail=f"Failed to finalize file save: {e}")

    try:
        new_stat = resolved.stat()
        new_mtime_ns = new_stat.st_mtime_ns
    except OSError:
        new_mtime_ns = 0

    # Record single Activity Log entry on successful save
    parent_str = str(resolved.parent)
    db.add_activity(
        kind="edit",
        message={
            "operation": "edit",
            "status": "succeeded",
            "name": resolved.name,
            "path": str(resolved),
            "destination": parent_str,
            "summary": f"{resolved.name} → {parent_str}",
            "error": None,
        },
    )

    return {
        "success": True,
        "mtime_ns": str(new_mtime_ns),
        "path": str(resolved),
    }
