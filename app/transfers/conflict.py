from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from app.transfers import db

class ConflictSkipped(Exception):
    """Raised when a task should be skipped due to a conflict."""
    pass

@dataclass
class ConflictResolution:
    target_path: Path
    drop_ignore: bool

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

def resolve_conflict(target_path: Path, on_conflict: str, log_path: Path, task_id: str) -> ConflictResolution:
    drop_ignore = False
    
    if on_conflict == "rename":
        target_path = compute_next_available_name(target_path)
    elif on_conflict == "overwrite":
        if target_path.exists() and target_path.is_file():
            try:
                target_path.unlink()
            except OSError:
                pass
        drop_ignore = True
    elif on_conflict == "skip":
        if target_path.exists() and target_path.is_file():
            log_path.parent.mkdir(parents=True, exist_ok=True)
            err = f"Destination item already exists: {target_path.name}"
            try:
                with open(log_path, "wb") as log_fh:
                    log_fh.write(f"Error: {err}\n".encode("utf-8"))
            except OSError:
                pass
            db.mark_finished(task_id, "failed", 1, err)
            raise ConflictSkipped(err)
            
    return ConflictResolution(target_path, drop_ignore)
