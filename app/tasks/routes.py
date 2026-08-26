from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import resolve_safe_path
from app.tasks import db
from app.tasks.runner import start_tmux_task

router = APIRouter(prefix="/api")

_LINE_SPLIT = re.compile(r"[\r\n]")


class TransferRequest(BaseModel):
    sources: list[str]
    destination: str
    delete_source: bool = False


@router.post("/transfer")
async def create_transfer(body: TransferRequest, user: str = Depends(get_current_user)):
    settings = get_settings()

    if not body.sources:
        raise HTTPException(status_code=400, detail="No sources selected")

    resolved_sources = [str(resolve_safe_path(s, settings.allowed_roots)) for s in body.sources]
    resolved_destination = resolve_safe_path(body.destination, settings.allowed_roots)

    if not resolved_destination.is_dir():
        raise HTTPException(status_code=400, detail="Destination must be an existing directory")

    task_id = start_tmux_task(
        settings=settings,
        sources=resolved_sources,
        destination=str(resolved_destination),
        delete_source=body.delete_source,
        created_by=user,
    )
    return {"task_id": task_id}


@router.get("/tasks")
async def get_tasks(limit: int = 50, offset: int = 0, _user: str = Depends(get_current_user)):
    return {"tasks": db.list_tasks(limit=limit, offset=offset)}


@router.get("/tasks/{task_id}")
async def get_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    return task


@router.get("/tasks/{task_id}/stream")
async def stream_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")

    log_path = Path(task["log_path"])

    async def generator():
        offset = 0
        while True:
            if log_path.exists():
                with open(log_path, "rb") as f:
                    f.seek(offset)
                    chunk = f.read()
                if chunk:
                    offset += len(chunk)
                    text = chunk.decode("utf-8", errors="replace")
                    for line in _LINE_SPLIT.split(text):
                        if line.strip():
                            yield f"data: {line}\n\n"

            current = db.get_task(task_id)
            if current is None:
                break
            if current["status"] not in ("queued", "running"):
                yield f"event: status\ndata: {json.dumps({'status': current['status']})}\n\n"
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(generator(), media_type="text/event-stream")
