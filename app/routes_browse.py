from __future__ import annotations

import base64
import hashlib
import hmac
import os
import secrets
import shutil
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request
from pydantic import BaseModel
from starlette.datastructures import MutableHeaders, UploadFile
from starlette.formparsers import MultiPartException
from starlette.requests import ClientDisconnect
from starlette.responses import FileResponse, Response
from starlette.types import Send

from app.auth import get_current_user, read_session_cookie, verify_password
from app.config import get_download_signing_key, get_settings
from app.fsops import list_directory, resolve_safe_path, compute_next_available_name
from app.tasks import db

router = APIRouter(prefix="/api")


class LiteSyncFileResponse(FileResponse):
    """FileResponse with explicit HTTP 416 rejection for multi-range requests."""

    async def _handle_multiple_ranges(
        self,
        send: Send,
        ranges: list[tuple[int, int]],
        file_size: int,
        send_header_only: bool,
    ) -> None:
        headers = MutableHeaders(raw=list(self.raw_headers))
        headers["content-range"] = f"bytes */{file_size}"
        headers["content-length"] = "0"
        await send({"type": "http.response.start", "status": 416, "headers": headers.raw})
        await send({"type": "http.response.body", "body": b"", "more_body": False})


def compute_download_signature(canonical_path: str | Path, expires: int, key: bytes | str) -> str:
    """Compute HMAC-SHA256 signature over the canonical path and expiry timestamp."""
    canonical_data = f"{canonical_path}|{expires}"
    if isinstance(key, str):
        key = key.encode("utf-8")
    return hmac.new(key, canonical_data.encode("utf-8"), hashlib.sha256).hexdigest()


def verify_download_signature(canonical_path: str | Path, expires: int, signature: str, key: bytes | str) -> bool:
    """Verify HMAC-SHA256 signature in constant time."""
    expected = compute_download_signature(canonical_path, expires, key)
    return hmac.compare_digest(expected, signature)


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


@router.get("/download/link")
async def get_download_link(
    path: str,
    _user: str = Depends(get_current_user),
):
    """Generate a server-side signed URL for file download or VLC/mpv streaming.

    Requires an authenticated user session. The signing key is never exposed to the client.
    """
    settings = get_settings()
    resolved = resolve_safe_path(path, settings.allowed_roots)
    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    expires = int(time.time()) + settings.download_expiry
    signing_key = get_download_signing_key(settings)
    signature = compute_download_signature(resolved, expires, signing_key)
    download_url = f"/api/download?path={quote(str(resolved))}&expires={expires}&signature={signature}"

    return {
        "url": download_url,
        "path": str(resolved),
        "expires": expires,
    }


@router.api_route("/download", methods=["GET", "HEAD"])
async def download_file(
    path: str,
    request: Request,
    expires: int | None = None,
    signature: str | None = None,
    litesync_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Single HTTP file endpoint for browser downloads and streaming.

    Accepts either a valid signed URL or an authenticated session.
    Derives filename strictly from the server-validated path.
    """
    settings = get_settings()

    # 1. Signed URL authentication (direct link)
    if signature is not None and expires is not None:
        now = int(time.time())
        if expires < now:
            raise HTTPException(status_code=403, detail="Download link has expired")
        resolved = resolve_safe_path(path, settings.allowed_roots)
        signing_key = get_download_signing_key(settings)
        if not verify_download_signature(resolved, expires, signature, signing_key):
            raise HTTPException(status_code=403, detail="Invalid download signature")
    # 2. Session cookie / Authorization header authentication (Browser / CLI)
    else:
        authenticated = False
        if litesync_session:
            username = read_session_cookie(litesync_session)
            if username:
                authenticated = True
        if not authenticated and authorization:
            if authorization.startswith("Bearer "):
                bearer_token = authorization[7:].strip()
                if read_session_cookie(bearer_token):
                    authenticated = True
            elif authorization.startswith("Basic "):
                try:
                    decoded = base64.b64decode(authorization[6:].strip()).decode("utf-8")
                    user, password = decoded.split(":", 1)
                    u = settings.find_user(user)
                    if u and verify_password(password, u.password_hash):
                        authenticated = True
                except Exception:
                    pass

        if not authenticated:
            raise HTTPException(status_code=401, detail="Not authenticated")
        resolved = resolve_safe_path(path, settings.allowed_roots)

    if not resolved.exists():
        raise HTTPException(status_code=404, detail="Path does not exist")
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="Path is not a file")

    return LiteSyncFileResponse(path=resolved, filename=resolved.name)


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
            "summary": target.name,
            "error": None,
        },
    )

    return {"success": True, "path": str(target)}


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


