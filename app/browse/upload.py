from __future__ import annotations

import os
import secrets
import shutil

from fastapi import APIRouter, Depends, HTTPException, Request
from starlette.datastructures import UploadFile
from starlette.formparsers import MultiPartException
from starlette.requests import ClientDisconnect
from starlette.responses import Response

from app.auth import get_current_user
from app.config import get_settings
from app.fsops import resolve_safe_path
from app.transfers.conflict import compute_next_available_name
from app.transfers import db

router = APIRouter(prefix="/api")

def validate_upload_filename(raw_name: str | None) -> str:
    """Validate a client-supplied filename for upload.

    Rejects filenames containing path separators, empty/dot names, or NUL bytes.
    Returns the sanitized bare filename.
    """
    if raw_name is None or not isinstance(raw_name, str):
        raise HTTPException(status_code=400, detail="Filename cannot be empty")

    if "\x00" in raw_name:
        raise HTTPException(status_code=400, detail="Filename contains NUL byte")

    if "/" in raw_name or "\\" in raw_name:
        raise HTTPException(status_code=400, detail="Filename cannot contain path separators ('/' or '\\')")

    cleaned = raw_name.strip()
    if not cleaned or cleaned in (".", ".."):
        raise HTTPException(status_code=400, detail="Invalid filename")

    if os.path.basename(cleaned) != cleaned:
        raise HTTPException(status_code=400, detail="Invalid filename")

    return cleaned


@router.post("/upload")
async def upload_files(
    request: Request,
    _user: str = Depends(get_current_user),
):
    settings = get_settings()

    # 1. Parse multipart form with explicit exception handling for client disconnect
    try:
        form = await request.form()
    except ClientDisconnect:
        # Client dropped connection mid-upload: silently abandon, no activity log entry
        return Response(status_code=499)
    except MultiPartException as e:
        raise HTTPException(status_code=400, detail=f"Malformed upload request: {e}")

    path_val = form.get("path")
    if not path_val or not isinstance(path_val, str):
        raise HTTPException(status_code=400, detail="Destination path is required")

    dest_dir = resolve_safe_path(path_val, settings.allowed_roots)
    if not dest_dir.is_dir():
        raise HTTPException(status_code=400, detail="Destination path must be an existing directory")

    on_conflict_val = form.get("on_conflict") or "skip"
    if not isinstance(on_conflict_val, str) or on_conflict_val not in ("skip", "overwrite", "rename"):
        raise HTTPException(status_code=400, detail="Invalid on_conflict parameter")

    # Collect UploadFile items from form
    files: list[UploadFile] = []
    for _key, value in form.multi_items():
        if isinstance(value, UploadFile) or (hasattr(value, "filename") and hasattr(value, "file")):
            files.append(value)

    if not files:
        raise HTTPException(status_code=400, detail="No files provided for upload")

    max_upload_bytes = settings.max_upload_size_mb * 1024 * 1024
    chunk_size = 1024 * 1024  # 1MB chunked copy
    uploaded_results: list[dict] = []

    for file in files:
        # 2. Validate bare filename
        raw_name = file.filename or ""
        try:
            filename = validate_upload_filename(raw_name)
        except HTTPException as e:
            # Log failure activity for invalid filename
            db.add_activity(
                kind="upload",
                message={
                    "operation": "upload",
                    "status": "failed",
                    "name": raw_name or "unknown",
                    "path": str(dest_dir / (raw_name or "unknown")),
                    "destination": str(dest_dir),
                    "summary": f"{raw_name or 'unknown'} → {dest_dir}",
                    "error": e.detail,
                },
            )
            raise e

        final_path = dest_dir / filename
        final_resolved = resolve_safe_path(str(final_path), settings.allowed_roots)

        # 3. Initial collision check before disk copy
        if final_resolved.exists():
            if on_conflict_val == "skip":
                err_msg = "A file or directory with that name already exists"
                db.add_activity(
                    kind="upload",
                    message={
                        "operation": "upload",
                        "status": "failed",
                        "name": filename,
                        "path": str(final_resolved),
                        "destination": str(dest_dir),
                        "summary": f"{filename} → {dest_dir}",
                        "error": err_msg,
                    },
                )
                raise HTTPException(status_code=400, detail=f"A file or directory named '{filename}' already exists")
            elif on_conflict_val == "rename":
                final_resolved = compute_next_available_name(final_resolved)
                filename = final_resolved.name
            elif on_conflict_val == "overwrite":
                pass

        # 4. Check Starlette-declared file size if available
        if file.size is not None and file.size > max_upload_bytes:
            err_msg = f"File exceeds maximum upload size of {settings.max_upload_size_mb} MB"
            db.add_activity(
                kind="upload",
                message={
                    "operation": "upload",
                    "status": "failed",
                    "name": filename,
                    "path": str(final_resolved),
                    "destination": str(dest_dir),
                    "summary": f"{filename} → {dest_dir}",
                    "error": err_msg,
                },
            )
            raise HTTPException(status_code=413, detail=err_msg)

        # 5. Create temporary file in destination directory: .litesync-upload-<hex>.tmp
        temp_filename = f".litesync-upload-{secrets.token_hex(8)}.tmp"
        temp_path = dest_dir / temp_filename
        bytes_written = 0

        try:
            with open(temp_path, "wb") as out_f:
                while True:
                    chunk = await file.read(chunk_size)
                    if not chunk:
                        break
                    bytes_written += len(chunk)
                    if bytes_written > max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail=f"File exceeds maximum upload size of {settings.max_upload_size_mb} MB",
                        )
                    out_f.write(chunk)
        except ClientDisconnect:
            # Client disconnected mid-transfer: delete temp file silently, no activity log entry
            temp_path.unlink(missing_ok=True)
            return Response(status_code=499)
        except Exception as e:
            temp_path.unlink(missing_ok=True)
            error_detail = e.detail if isinstance(e, HTTPException) else f"Failed to write file to disk: {e}"
            status_code = e.status_code if isinstance(e, HTTPException) else 500
            db.add_activity(
                kind="upload",
                message={
                    "operation": "upload",
                    "status": "failed",
                    "name": filename,
                    "path": str(final_resolved),
                    "destination": str(dest_dir),
                    "summary": f"{filename} → {dest_dir}",
                    "error": error_detail,
                },
            )
            raise HTTPException(status_code=status_code, detail=error_detail) from e

        # 6. Synchronous final collision check and atomic rename (NO await, zero event loop yield)
        if final_resolved.exists():
            if on_conflict_val == "skip":
                temp_path.unlink(missing_ok=True)
                err_msg = "A file or directory with that name already exists"
                db.add_activity(
                    kind="upload",
                    message={
                        "operation": "upload",
                        "status": "failed",
                        "name": filename,
                        "path": str(final_resolved),
                        "destination": str(dest_dir),
                        "summary": f"{filename} → {dest_dir}",
                        "error": err_msg,
                    },
                )
                raise HTTPException(status_code=400, detail=f"A file or directory named '{filename}' already exists")
            elif on_conflict_val == "rename":
                final_resolved = compute_next_available_name(final_resolved)
                filename = final_resolved.name
            elif on_conflict_val == "overwrite":
                try:
                    if final_resolved.is_dir() and not final_resolved.is_symlink():
                        shutil.rmtree(final_resolved, ignore_errors=True)
                    else:
                        final_resolved.unlink(missing_ok=True)
                except OSError:
                    pass

        try:
            os.rename(temp_path, final_resolved)
        except OSError as e:
            temp_path.unlink(missing_ok=True)
            db.add_activity(
                kind="upload",
                message={
                    "operation": "upload",
                    "status": "failed",
                    "name": filename,
                    "path": str(final_resolved),
                    "destination": str(dest_dir),
                    "summary": f"{filename} → {dest_dir}",
                    "error": f"Failed to finalize upload: {e}",
                },
            )
            raise HTTPException(status_code=500, detail=f"Failed to finalize upload: {e}")

        # 7. Record single terminal success entry in Activity Log
        db.add_activity(
            kind="upload",
            message={
                "operation": "upload",
                "status": "succeeded",
                "name": filename,
                "path": str(final_resolved),
                "destination": str(dest_dir),
                "size": bytes_written,
                "summary": f"{filename} → {dest_dir}",
                "error": None,
            },
        )

        uploaded_results.append({
            "name": filename,
            "path": str(final_resolved),
            "size": bytes_written,
        })

    return {
        "success": True,
        "destination": str(dest_dir),
        "files": uploaded_results,
    }
