from __future__ import annotations

import os
from pathlib import Path

from fastapi import HTTPException


def resolve_safe_path(requested: str, allowed_roots: list[Path]) -> Path:
    """Resolve a user-supplied path and ensure it falls within an allowed root.

    Uses realpath (not just normpath) so both '..' traversal and symlinks
    that point outside the allowed roots are rejected.
    """
    try:
        resolved = Path(os.path.realpath(requested))
    except (OSError, ValueError):
        raise HTTPException(status_code=400, detail="Invalid path")

    for root in allowed_roots:
        if resolved == root or str(resolved).startswith(str(root) + os.sep):
            return resolved

    raise HTTPException(status_code=403, detail="Path is outside allowed roots")


def list_directory(path: Path, allowed_roots: list[Path]) -> list[dict]:
    if not path.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")
    if not path.is_dir():
        raise HTTPException(status_code=400, detail="Not a directory")

    entries = []
    try:
        scanned = list(os.scandir(path))
    except PermissionError:
        raise HTTPException(status_code=403, detail="Permission denied")

    for entry in scanned:
        try:
            # Re-validate: a symlink inside an allowed root could point back out.
            entry_path = resolve_safe_path(entry.path, allowed_roots)
        except HTTPException:
            continue

        try:
            stat = entry.stat(follow_symlinks=True)
        except OSError:
            continue

        entries.append(
            {
                "name": entry.name,
                "path": str(entry_path),
                "is_dir": entry.is_dir(follow_symlinks=True),
                "size": stat.st_size,
                "mtime": stat.st_mtime,
            }
        )

    entries.sort(key=lambda e: (not e["is_dir"], e["name"].lower()))
    return entries


