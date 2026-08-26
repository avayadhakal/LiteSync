from __future__ import annotations

from fastapi import APIRouter, Depends

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import list_directory, resolve_safe_path

router = APIRouter(prefix="/api")


@router.get("/roots")
async def get_roots(_user: str = Depends(get_current_user)):
    settings = get_settings()
    return {"roots": [str(r) for r in settings.allowed_roots]}


@router.get("/browse")
async def browse(path: str, _user: str = Depends(get_current_user)):
    settings = get_settings()
    resolved = resolve_safe_path(path, settings.allowed_roots)
    entries = list_directory(resolved, settings.allowed_roots)

    parent = str(resolved.parent)
    is_root = any(resolved == r for r in settings.allowed_roots)

    return {
        "path": str(resolved),
        "parent": None if is_root else parent,
        "entries": entries,
    }
