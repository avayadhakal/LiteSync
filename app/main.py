from __future__ import annotations

import asyncio
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
from app.tasks.runner import reconcile_on_startup, run_scheduler

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="LiteSync")

app.include_router(auth_router)
app.include_router(browse_router)
app.include_router(tasks_router)

app.mount("/css", StaticFiles(directory=STATIC_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=STATIC_DIR / "js"), name="js")


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
    settings = get_settings()
    db.init_db(settings.data_dir)
    reconcile_on_startup(settings)
    asyncio.create_task(run_scheduler(settings))
