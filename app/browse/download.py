from __future__ import annotations

import base64
import hashlib
import hmac
import time
import mimetypes
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

# Explicit safe allowlist of MIME types safe for inline rendering
SAFE_INLINE_EXACT_MIMES = {
    "application/pdf",
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
    "text/plain",
}

# Markup / script-capable types to safely fallback to text/plain when inline is requested
TEXT_FALLBACK_EXTENSIONS = {
    ".html",
    ".htm",
    ".svg",
    ".xml",
    ".xhtml",
}

TEXT_FALLBACK_MIMES = {
    "text/html",
    "image/svg+xml",
    "application/xhtml+xml",
    "application/xml",
    "text/xml",
}


def is_safe_inline_mime(mime: str | None) -> bool:
    """Check if MIME type is explicitly allowed for inline browser rendering."""
    if not mime:
        return False
    mime = mime.lower().split(";")[0].strip()
    if mime in SAFE_INLINE_EXACT_MIMES:
        return True
    if mime.startswith("video/") or mime.startswith("audio/"):
        return True
    return False


def is_text_fallback_type(suffix: str, mime: str | None) -> bool:
    """Check if file should be treated with safe text/plain fallback when inline is requested."""
    if suffix.lower() in TEXT_FALLBACK_EXTENSIONS:
        return True
    if mime:
        clean_mime = mime.lower().split(";")[0].strip()
        if clean_mime in TEXT_FALLBACK_MIMES:
            return True
    return False


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
    disposition: str = "attachment",
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
    if disposition.lower() == "inline":
        download_url += "&disposition=inline"

    return {
        "url": download_url,
        "path": str(resolved),
        "expires": expires,
    }


@router.api_route("/download", methods=["GET", "HEAD"])
async def download_file(
    path: str,
    request: Request,
    disposition: str = "attachment",
    expires: int | None = None,
    signature: str | None = None,
    litesync_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
):
    """Single HTTP file endpoint for browser downloads and streaming.

    Accepts either a valid signed URL or an authenticated session.
    Derives filename strictly from the server-validated path.
    Enforces safe server-side inline allowlist with text/plain fallback and nosniff protection.
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

    # Determine MIME type and safe disposition
    guessed_type, _ = mimetypes.guess_type(resolved.name)
    suffix = resolved.suffix

    response_headers: dict[str, str] = {}
    content_disposition_type = "attachment"
    media_type = guessed_type

    if disposition.lower() == "inline":
        response_headers["X-Content-Type-Options"] = "nosniff"
        if is_safe_inline_mime(guessed_type) and not is_text_fallback_type(suffix, guessed_type):
            content_disposition_type = "inline"
            media_type = guessed_type
        elif is_text_fallback_type(suffix, guessed_type):
            content_disposition_type = "inline"
            media_type = "text/plain; charset=utf-8"
        else:
            # Not in safe allowlist and not text-fallback; force attachment
            content_disposition_type = "attachment"
            media_type = guessed_type
    else:
        content_disposition_type = "attachment"
        media_type = guessed_type

    return LiteSyncFileResponse(
        path=resolved,
        filename=resolved.name,
        media_type=media_type,
        content_disposition_type=content_disposition_type,
        headers=response_headers,
    )
