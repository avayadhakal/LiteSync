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
from app.tasks.runner import queue_task, terminate_task, wake_scheduler

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

    # Fire and forget: expand the batch into one queued task per source so
    # every selected item gets its own progress card, log, SSE stream, and
    # cancel control. The background scheduler independently picks these up.
    task_ids = [
        queue_task(
            settings=settings,
            source=source,
            destination=str(resolved_destination),
            delete_source=body.delete_source,
            created_by=user,
        )
        for source in resolved_sources
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


@router.delete("/tasks/{task_id}")
async def delete_task(task_id: str, _user: str = Depends(get_current_user)):

    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] in ("queued", "running"):
        raise HTTPException(status_code=400, detail="Cannot delete an active task")

    db.delete_task(task_id)

    log_path = Path(task["log_path"])
    task_dir = log_path.parent
    if task_dir.exists() and task_dir.is_dir():
        shutil.rmtree(task_dir, ignore_errors=True)

    return {"success": True}


@router.delete("/tasks")
async def delete_all_completed_tasks(_user: str = Depends(get_current_user)):
    # Retrieve all tasks and filter out completed ones
    tasks = db.list_tasks(limit=1000)
    for task in tasks:
        if task["status"] not in ("queued", "running"):
            db.delete_task(task["task_id"])
            log_path = Path(task["log_path"])
            task_dir = log_path.parent
            if task_dir.exists() and task_dir.is_dir():
                shutil.rmtree(task_dir, ignore_errors=True)

    return {"success": True}


@router.post("/tasks/{task_id}/cancel")
async def cancel_task(task_id: str, _user: str = Depends(get_current_user)):
    task = db.get_task(task_id)
    if task is None:
        raise HTTPException(status_code=404, detail="Task not found")
    if task["status"] not in ("queued", "running"):
        raise HTTPException(status_code=400, detail="Task is not active")

    settings = get_settings()

    if task["status"] == "queued":
        # Simply take it out of the queue; the scheduler only picks rows
        # with status='queued', so it is skipped. Nothing copied yet, so the
        # filesystem stays completely untouched.
        db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")
        return {"success": True}

    # Running: gracefully stop the rsync child. The scheduler escalates to
    # SIGKILL if SIGTERM is ignored within ~5s.
    terminate_task(task_id)
    db.mark_finished(task_id, "interrupted", None, "Transfer cancelled by user")

    # Cleanup destination items
    try:
        resolved_dest = resolve_safe_path(task["destination"], settings.allowed_roots)
        for src in task["sources"]:
            src_name = Path(src).name
            target = resolved_dest / src_name
            try:
                resolved_target = resolve_safe_path(str(target), settings.allowed_roots)
                # Verify that target is actually inside the destination folder
                if resolved_target == resolved_dest or not str(resolved_target).startswith(str(resolved_dest) + os.sep if str(resolved_dest) != "/" else "/"):
                    continue
                if resolved_target.is_dir():
                    shutil.rmtree(resolved_target, ignore_errors=True)
                elif resolved_target.exists() or resolved_target.is_symlink():
                    resolved_target.unlink(missing_ok=True)
            except Exception:
                pass
    except Exception:
        pass

    return {"success": True}

