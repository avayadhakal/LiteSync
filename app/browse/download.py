from __future__ import annotations

import base64
import hashlib
import hmac
import time
from pathlib import Path
from urllib.parse import quote

from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request
from starlette.datastructures import MutableHeaders
from starlette.responses import FileResponse
from starlette.types import Send

from app.auth import get_current_user, read_session_cookie, verify_password
from app.config import get_download_signing_key, get_settings
from app.fsops import resolve_safe_path

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
