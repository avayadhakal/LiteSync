from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import resolve_safe_path
from app.tasks import db
from app.tasks.runner import queue_task, terminate_task, wake_scheduler, pause_task_runner, terminate_paused_task

router = APIRouter(prefix="/api")


_LINE_SPLIT = re.compile(r"[\r\n]")


from typing import Union

class TransferSourceItem(BaseModel):
    path: str
    excludes: list[str] = []


class TransferRequest(BaseModel):
    sources: list[Union[str, TransferSourceItem]]
    destination: str
    operation: str = "copy"
    use_rsync: bool = False
    on_conflict: str = "skip"


@router.post("/transfer")
async def create_transfer(body: TransferRequest, user: str = Depends(get_current_user)):
    settings = get_settings()

    if not body.sources:
        raise HTTPException(status_code=400, detail="No sources selected")

    if body.operation not in ("copy", "move"):
        raise HTTPException(status_code=400, detail="Invalid operation. Must be 'copy' or 'move'")

    if body.on_conflict not in ("skip", "overwrite", "rename"):
        raise HTTPException(status_code=400, detail="Invalid on_conflict. Must be 'skip', 'overwrite', or 'rename'")

    resolved_destination = resolve_safe_path(body.destination, settings.allowed_roots)
    if not resolved_destination.is_dir():
        raise HTTPException(status_code=400, detail="Destination must be an existing directory")

    items_to_queue: list[tuple[str, list[str]]] = []
    for item in body.sources:
        if isinstance(item, str):
            src_str = item
            exc_list = []
        else:
            src_str = item.path
            exc_list = item.excludes

        resolved_src = str(resolve_safe_path(src_str, settings.allowed_roots))
        validated_excludes: list[str] = []
        for exc in exc_list:
            if not isinstance(exc, str):
                raise HTTPException(status_code=400, detail="Exclude item must be a string")
            exc_trimmed = exc.strip()
            if not exc_trimmed:
                continue
            if exc_trimmed.startswith("/") or exc_trimmed.startswith("\\"):
                raise HTTPException(
                    status_code=400,
                    detail=f"Exclude path must be relative without leading slash: {exc_trimmed}",
                )
            # Check for directory traversal escapes
            parts = [p for p in re.split(r"[/\\]", exc_trimmed) if p]
            if ".." in parts:
                raise HTTPException(
                    status_code=400,
                    detail=f"Exclude path cannot contain directory traversal '..': {exc_trimmed}",
                )
            validated_excludes.append(exc_trimmed)

        items_to_queue.append((resolved_src, validated_excludes))

    # Fire and forget: expand the batch into one queued task per source so
    # every selected item gets its own progress card, log, SSE stream, and
    # cancel control. The background scheduler independently picks these up.
    task_ids = [
        queue_task(
            settings=settings,
            source=source,
            destination=str(resolved_destination),
            operation=body.operation,
            excludes=excludes,
            use_rsync=body.use_rsync or bool(excludes),
            on_conflict=body.on_conflict,
        )
        for source, excludes in items_to_queue
    ]

    # Nudge the scheduler so the queue starts immediately (it polls the DB
    # on its own regardless).
    wake_scheduler()

    return {"task_ids": task_ids}


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

    settings = get_settings()
    log_path = db.get_task_log_path(task_id, settings.data_dir)

    async def generator():
        offset = 0
        while True:
            if log_path.exists():
                try:
                    with open(log_path, "rb") as f:
                        f.seek(offset)
                        chunk = f.read()
                    if chunk:
                        offset += len(chunk)
                        text = chunk.decode("utf-8", errors="replace")
                        for line in _LINE_SPLIT.split(text):
                            if line.strip():
                                yield f"data: {line}\n\n"
                except OSError:
                    pass

            current = db.get_task(task_id)
            if current is None:
                break
            if current["status"] not in ("queued", "running", "paused"):
                yield f"event: status\ndata: {json.dumps({'status': current['status']})}\n\n"
                break

            await asyncio.sleep(0.5)

    return StreamingResponse(generator(), media_type="text/event-stream")


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] in ("queued", "running", "paused"):
        raise HTTPException(status_code=400, detail="Cannot delete an active task")

    db.delete_task(task_id)

    settings = get_settings()
    flat_log = settings.data_dir / "tasks" / f"{task_id}.log"
    flat_log.unlink(missing_ok=True)

    return {"success": True}


@router.delete("/tasks")
async def delete_all_completed_tasks(_user: str = Depends(get_current_user)):
    settings = get_settings()
    tasks = db.list_tasks(limit=1000)
    for task in tasks:
        if task["status"] not in ("queued", "running", "paused"):
            t_id = task["id"]
            db.delete_task(t_id)
            flat_log = settings.data_dir / "tasks" / f"{t_id}.log"
            flat_log.unlink(missing_ok=True)

    return {"success": True}


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] not in ("queued", "running", "paused"):
        raise HTTPException(status_code=400, detail="Task is not active")

    if task["status"] == "queued":
        db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")
        return {"success": True}

    if task["status"] == "paused":
        terminate_paused_task(task_id)
        db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")
        return {"success": True}

    terminate_task(task_id)
    db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")
    return {"success": True}

@router.post("/tasks/{task_id}/pause")
async def pause_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] != "running":
        raise HTTPException(status_code=400, detail="Task is not currently running")
    if not task.get("use_rsync"):
        raise HTTPException(status_code=400, detail="Cannot pause a kernel-copy task")

    success = pause_task_runner(task_id)
    if not success:
        raise HTTPException(status_code=400, detail="Failed to pause task")
    
    db.mark_paused(task_id)
    return {"success": True}

@router.post("/tasks/{task_id}/resume")
async def resume_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] != "paused":
        raise HTTPException(status_code=400, detail="Task is not paused")

    db.mark_queued(task_id)
    wake_scheduler()
    return {"success": True}


@router.get("/activity")
async def get_activity(limit: int = 100, offset: int = 0, _user: str = Depends(get_current_user)):
    return {"activity": db.list_activity(limit=limit, offset=offset)}


@router.delete("/activity")
async def clear_activity(_user: str = Depends(get_current_user)):
    db.clear_activity()
    return {"success": True}



