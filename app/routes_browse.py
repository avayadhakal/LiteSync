import os
from pydantic import BaseModel
from fastapi import APIRouter, Depends, HTTPException

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import list_directory, resolve_safe_path

router = APIRouter(prefix="/api")


class MkdirRequest(BaseModel):
    path: str
    name: str


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


@router.post("/mkdir")
async def create_folder(body: MkdirRequest, _user: str = Depends(get_current_user)):
    settings = get_settings()
    folder_name = body.name.strip()
    if not folder_name or "/" in folder_name or "\\" in folder_name:
        raise HTTPException(status_code=400, detail="Invalid folder name")

    parent_resolved = resolve_safe_path(body.path, settings.allowed_roots)
    if not parent_resolved.is_dir():
        raise HTTPException(status_code=400, detail="Parent path must be a directory")

    new_dir = resolve_safe_path(os.path.join(str(parent_resolved), folder_name), settings.allowed_roots)
    if new_dir.exists():
        raise HTTPException(status_code=400, detail="Directory already exists")

    try:
        new_dir.mkdir(parents=True, exist_ok=False)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to create directory: {e}")

    return {"success": True, "path": str(new_dir)}

