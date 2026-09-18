from __future__ import annotations

import base64
import sys
import time

import bcrypt
from fastapi import APIRouter, Cookie, Depends, Header, HTTPException, Request, Response
from itsdangerous import BadSignature, SignatureExpired, URLSafeTimedSerializer
from pydantic import BaseModel

from app.config import get_settings

COOKIE_NAME = "litesync_session"

# In-memory login lockout tracking: username -> list of failed-attempt timestamps.
_failed_attempts: dict[str, list[float]] = {}
LOCKOUT_THRESHOLD = 5
LOCKOUT_WINDOW_SECONDS = 15 * 60


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode(), password_hash.encode())
    except ValueError:
        return False


def _serializer() -> URLSafeTimedSerializer:
    settings = get_settings()
    return URLSafeTimedSerializer(settings.secret_key, salt="litesync-session")


def create_session_cookie(username: str, password_hash: str) -> str:
    return _serializer().dumps({
        "username": username,
        "hash_suffix": password_hash[-12:]
    })


def read_session_cookie(cookie: str) -> dict | None:
    settings = get_settings()
    try:
        data = _serializer().loads(cookie, max_age=settings.session_max_age)
    except (BadSignature, SignatureExpired):
        return None
    if isinstance(data, dict):
        return data
    return None


def is_locked_out(username: str) -> bool:
    attempts = _failed_attempts.get(username, [])
    cutoff = time.time() - LOCKOUT_WINDOW_SECONDS
    attempts = [t for t in attempts if t > cutoff]
    _failed_attempts[username] = attempts
    return len(attempts) >= LOCKOUT_THRESHOLD


def record_failed_attempt(username: str) -> None:
    _failed_attempts.setdefault(username, []).append(time.time())


def clear_failed_attempts(username: str) -> None:
    _failed_attempts.pop(username, None)


async def get_current_user(
    request: Request,
    litesync_session: str | None = Cookie(default=None),
    authorization: str | None = Header(default=None),
) -> str:
    # 1. Cookie authentication (standard web browser session)
    if litesync_session:
        data = read_session_cookie(litesync_session)
        if data and "username" in data:
            username = data["username"]
            settings = get_settings()
            u = settings.find_user(username)
            if u and data.get("hash_suffix") == u.password_hash[-12:]:
                return username

    # 2. Authorization header authentication (Bearer token or Basic auth)
    if authorization:
        if authorization.startswith("Bearer "):
            bearer_token = authorization[7:].strip()
            data = read_session_cookie(bearer_token)
            if data and "username" in data:
                username = data["username"]
                settings = get_settings()
                u = settings.find_user(username)
                if u and data.get("hash_suffix") == u.password_hash[-12:]:
                    return username
        elif authorization.startswith("Basic "):
            try:
                decoded = base64.b64decode(authorization[6:].strip()).decode("utf-8")
                user, password = decoded.split(":", 1)
                settings = get_settings()
                u = settings.find_user(user)
                if u and verify_password(password, u.password_hash):
                    return user
            except Exception:
                pass

    if request.url.path.startswith("/api/"):
        raise HTTPException(status_code=401, detail="Not authenticated")

    raise HTTPException(
        status_code=303,
        headers={"Location": "/login.html"},
    )


router = APIRouter(prefix="/api")


class LoginRequest(BaseModel):
    username: str
    password: str


@router.post("/login")
async def login(body: LoginRequest, response: Response):
    settings = get_settings()

    if is_locked_out(body.username):
        raise HTTPException(status_code=429, detail="Too many failed attempts, try again later")

    user = settings.find_user(body.username)
    if user is None or not verify_password(body.password, user.password_hash):
        record_failed_attempt(body.username)
        raise HTTPException(status_code=401, detail="Invalid username or password")

    clear_failed_attempts(body.username)
    cookie_value = create_session_cookie(body.username, user.password_hash)
    response.set_cookie(
        key=COOKIE_NAME,
        value=cookie_value,
        max_age=settings.session_max_age,
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookie,
    )
    return {"ok": True}


class ChangePasswordRequest(BaseModel):
    current_password: str
    new_password: str


@router.post("/change-password")
async def change_password(body: ChangePasswordRequest, request: Request, response: Response, username: str = Depends(get_current_user)):
    settings = get_settings()

    if is_locked_out(username):
        raise HTTPException(status_code=429, detail="Too many failed attempts, try again later")

    user = settings.find_user(username)
    if user is None or not verify_password(body.current_password, user.password_hash):
        record_failed_attempt(username)
        raise HTTPException(status_code=401, detail="Invalid current password")

    clear_failed_attempts(username)
    
    if len(body.new_password) < 8:
        raise HTTPException(status_code=400, detail="New password must be at least 8 characters")

    new_hash = hash_password(body.new_password)
    from app.transfers.db import update_user_password
    update_user_password(username, new_hash)

    cookie_value = create_session_cookie(username, new_hash)
    response.set_cookie(
        key=COOKIE_NAME,
        value=cookie_value,
        max_age=settings.session_max_age,
        httponly=True,
        samesite="lax",
        secure=settings.secure_cookie,
    )
    return {"ok": True}


@router.post("/logout")
async def logout(response: Response):
    response.delete_cookie(COOKIE_NAME)
    return {"ok": True}


@router.get("/whoami")
async def whoami(user: str = Depends(get_current_user)):
    return {"username": user}


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] != "hash":
        print("Usage: python -m app.auth hash <password>", file=sys.stderr)
        sys.exit(1)
    print(hash_password(sys.argv[2]))


if __name__ == "__main__":
    main()
