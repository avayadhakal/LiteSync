from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

from fastapi import Depends, FastAPI
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from app.auth import get_current_user
from app.auth import router as auth_router
from app.config import get_settings
from app.routes_browse import router as browse_router
from app.tasks import db
from app.tasks.routes import router as tasks_router
from app.tasks.runner import reconcile_on_startup, run_scheduler, shutdown_runner

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="LiteSync")

app.include_router(auth_router)
app.include_router(browse_router)
app.include_router(tasks_router)

app.mount("/css", StaticFiles(directory=STATIC_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=STATIC_DIR / "js"), name="js")

_scheduler_task: asyncio.Task | None = None


@app.get("/login.html")
async def login_page():
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/index.html")
async def index_page(_user: str = Depends(get_current_user)):
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/")
async def root(_user: str = Depends(get_current_user)):
    return FileResponse(STATIC_DIR / "index.html")


@app.on_event("startup")
async def on_startup():
    global _scheduler_task
    settings = get_settings()
    db.init_db(settings.data_dir)
    
    # Secondary/defensive fix for upload spooling. 
    # In production, the systemd unit's Environment=TMPDIR=/opt/litesync/data/tmp
    # is the primary mechanism to keep large spooled uploads out of RAM (tmpfs).
    # This tempfile override provides a fallback for dev/debug non-systemd invocations.
    tmp_dir = settings.data_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)
    tempfile.tempdir = str(tmp_dir)
    
    reconcile_on_startup(settings)
    _scheduler_task = asyncio.create_task(run_scheduler(settings))


@app.on_event("shutdown")
async def on_shutdown():
    global _scheduler_task
    if _scheduler_task is not None:
        _scheduler_task.cancel()
        try:
            await _scheduler_task
        except (asyncio.CancelledError, Exception):
            pass
    await shutdown_runner()
