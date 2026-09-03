from __future__ import annotations

import os
import shutil

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import list_directory, resolve_safe_path
from app.transfers import db

router = APIRouter(prefix="/api")

class MkdirRequest(BaseModel):
    path: str
    name: str

class RenameRequest(BaseModel):
    path: str
    new_name: str

class DeleteRequest(BaseModel):
    path: str

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

    parent_name = parent_resolved.name
    summary = f"{parent_name}/{folder_name}" if parent_name else folder_name
    db.add_activity(
        kind="mkdir",
        message={
            "operation": "mkdir",
            "status": "succeeded",
            "path": str(new_dir),
            "name": folder_name,
            "parent": str(parent_resolved),
            "summary": summary,
            "error": None,
        },
    )

    return {"success": True, "path": str(new_dir)}

@router.post("/rename")
async def rename_entry(body: RenameRequest, _user: str = Depends(get_current_user)):
    settings = get_settings()
    new_name = body.new_name.strip()
    if not new_name or "/" in new_name or "\\" in new_name:
        raise HTTPException(status_code=400, detail="Invalid name")

    source = resolve_safe_path(body.path, settings.allowed_roots)
    # Never allow renaming an allowed root itself.
    if any(source == r for r in settings.allowed_roots):
        raise HTTPException(status_code=400, detail="Cannot rename an allowed root")
    if not source.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")

    target = resolve_safe_path(os.path.join(str(source.parent), new_name), settings.allowed_roots)
    if target.exists():
        raise HTTPException(status_code=400, detail="A file or directory with that name already exists")

    file_size = None
    try:
        if not source.is_dir():
            file_size = source.stat().st_size
    except OSError:
        pass

    try:
        source.rename(target)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to rename: {e}")

    db.add_activity(
        kind="rename",
        message={
            "operation": "rename",
            "status": "succeeded",
            "old_path": str(source),
            "new_path": str(target),
            "old_name": source.name,
            "new_name": target.name,
            "size": file_size,
            "summary": f"{source.name} → {target.name}",
            "error": None,
        },
    )

    return {"success": True, "old_path": str(source), "new_path": str(target)}

@router.post("/delete")
async def delete_entry(body: DeleteRequest, _user: str = Depends(get_current_user)):
    settings = get_settings()
    target = resolve_safe_path(body.path, settings.allowed_roots)
    # Never allow deleting an allowed root itself.
    if any(target == r for r in settings.allowed_roots):
        raise HTTPException(status_code=400, detail="Cannot delete an allowed root")
    if not target.exists() and not target.is_symlink():
        raise HTTPException(status_code=404, detail="Path does not exist")

    file_size = None
    try:
        if not target.is_dir():
            file_size = target.stat().st_size
    except OSError:
        pass

    try:
        if target.is_dir() and not target.is_symlink():
            shutil.rmtree(target)
        else:
            target.unlink()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Failed to delete: {e}")

    db.add_activity(
        kind="delete",
        message={
            "operation": "delete",
            "status": "succeeded",
            "path": str(target),
            "name": target.name,
            "size": file_size,
            "summary": target.name,
            "error": None,
        },
    )

    return {"success": True, "path": str(target)}
