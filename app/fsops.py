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


def compute_next_available_name(target_path: Path) -> Path:
    """Compute the next available name by checking existence and incrementing."""
    if not target_path.exists():
        return target_path

    parent = target_path.parent
    name = target_path.name

    try:
        is_dir = target_path.is_dir()
    except OSError:
        is_dir = False

    if is_dir:
        stem = name
        suffix = ""
    else:
        # Avoid treating dotfiles like ".bashrc" as having stem "" and suffix ".bashrc"
        if name.startswith(".") and name.count(".") == 1:
            stem = name
            suffix = ""
        else:
            stem = target_path.stem
            suffix = target_path.suffix

    i = 1
    while True:
        new_path = parent / f"{stem}_{i}{suffix}"
        if not new_path.exists():
            return new_path
        i += 1
