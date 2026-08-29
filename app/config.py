from __future__ import annotations

import hashlib
import hmac
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class User:
    username: str
    password_hash: str


@dataclass(frozen=True)
class Settings:
    allowed_roots: list[Path]
    users: list[User]
    secret_key: str
    session_max_age: int
    secure_cookie: bool
    data_dir: Path
    host: str
    port: int
    download_expiry: int = 86400
    download_secret_key: str | None = None
    max_upload_size_mb: int = 5120

    def find_user(self, username: str) -> User | None:
        for user in self.users:
            if user.username == username:
                return user
        return None


_settings: Settings | None = None


def load_settings(config_path_override: Path | str | None = None) -> Settings:
    if config_path_override is not None:
        config_path = Path(config_path_override).resolve()
    else:
        config_path = Path(os.environ.get("LITESYNC_CONFIG", "./config.toml")).resolve()

    if not config_path.exists():
        yaml_hint = ""
        legacy_yaml = config_path.parent / "config.yaml"
        if legacy_yaml.exists():
            yaml_hint = f" Found legacy {legacy_yaml.name} - please migrate your settings to config.toml."
        raise FileNotFoundError(
            f"Config file not found at {config_path}.{yaml_hint} Copy config.example.toml to "
            "config.toml and edit it, or set LITESYNC_CONFIG."
        )

    with open(config_path, "rb") as f:
        raw = tomllib.load(f)

    allowed_roots = [Path(p).resolve() for p in raw.get("allowed_roots", [])]
    users = [User(username=u["username"], password_hash=u["password_hash"]) for u in raw.get("users", [])]
    data_dir = Path(raw.get("data_dir", "./data")).resolve()

    return Settings(
        allowed_roots=allowed_roots,
        users=users,
        secret_key=raw["secret_key"],
        session_max_age=int(raw.get("session_max_age", 604800)),
        secure_cookie=bool(raw.get("secure_cookie", False)),
        data_dir=data_dir,
        host=raw.get("host", "0.0.0.0"),
        port=int(raw.get("port", 8000)),
        download_expiry=int(raw.get("download_expiry", 86400)),
        download_secret_key=raw.get("download_secret_key"),
        max_upload_size_mb=int(raw.get("max_upload_size_mb", 5120)),
    )


def get_download_signing_key(settings: Settings) -> bytes:
    """Derive a domain-separated download signing key.

    If an explicit download_secret_key is provided in configuration, it is used.
    Otherwise, a dedicated key is derived from secret_key using HMAC-SHA256 with
    the domain label 'litesync-download-signing' to decouple download URL signing
    from session cookie signing.
    """
    if settings.download_secret_key:
        return settings.download_secret_key.encode("utf-8")
    return hmac.new(settings.secret_key.encode("utf-8"), b"litesync-download-signing", hashlib.sha256).digest()


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings
