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
from app.browse import router as browse_router
from app.transfers import db
from app.transfers.routes import router as tasks_router
from app.transfers.scheduler import reconcile_on_startup, run_scheduler, shutdown_runner

STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

app = FastAPI(title="LiteSync")

from urllib.parse import urlparse
from fastapi import Request
from fastapi.responses import JSONResponse

@app.middleware("http")
async def csrf_protection(request: Request, call_next):
    if request.method in ("POST", "DELETE", "PUT", "PATCH"):
        # Exclude requests authenticated explicitly via Authorization header
        if not request.headers.get("authorization"):
            origin = request.headers.get("origin")
            referer = request.headers.get("referer")
            
            source_origin = origin
            if not source_origin and referer:
                parsed = urlparse(referer)
                source_origin = f"{parsed.scheme}://{parsed.netloc}"
                
            settings = get_settings()
            
            is_valid = False
            if source_origin:
                if settings.allowed_origins:
                    if source_origin in settings.allowed_origins:
                        is_valid = True
                elif settings.host in ("0.0.0.0", "::", ""):
                    parsed = urlparse(source_origin)
                    expected_scheme = "https" if settings.secure_cookie else "http"
                    port = parsed.port or (443 if parsed.scheme == "https" else 80)
                    if parsed.scheme == expected_scheme and port == settings.port:
                        is_valid = True
            
            if not is_valid:
                return JSONResponse(status_code=403, content={"detail": "CSRF check failed: Origin/Referer mismatch"})
                
    return await call_next(request)

@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=(), interest-cohort=()"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Content-Security-Policy"] = "default-src 'self'; style-src 'self' 'unsafe-inline';"
    return response


app.include_router(auth_router)
app.include_router(browse_router)
app.include_router(tasks_router)

app.mount("/css", StaticFiles(directory=STATIC_DIR / "css"), name="css")
app.mount("/js", StaticFiles(directory=STATIC_DIR / "js"), name="js")
app.mount("/assets", StaticFiles(directory=STATIC_DIR / "assets"), name="assets")
app.mount("/locales", StaticFiles(directory=STATIC_DIR / "locales"), name="locales")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

_scheduler_task: asyncio.Task | None = None


@app.get("/login.html")
async def login_page():
    return FileResponse(STATIC_DIR / "login.html")


@app.get("/index.html")
async def index_page(_user: str = Depends(get_current_user)):
    return FileResponse(STATIC_DIR / "index.html")


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(STATIC_DIR / "favicon.ico")

@app.get("/")
async def root(_user: str = Depends(get_current_user)):
    return FileResponse(STATIC_DIR / "index.html")


import logging
logger = logging.getLogger("litesync")

@app.on_event("startup")
async def on_startup():
    global _scheduler_task
    settings = get_settings()
    
    if settings.host in ("0.0.0.0", "::", "") and not settings.allowed_origins:
        logger.warning("Running on wildcard host without explicit allowed_origins. For tighter security in production, set allowed_origins in config.toml.")
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
