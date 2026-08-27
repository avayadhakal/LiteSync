from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml


@dataclass
class User:
    username: str
    password_hash: str


@dataclass
class Settings:
    allowed_roots: list[Path]
    users: list[User]
    secret_key: str
    session_max_age: int
    secure_cookie: bool
    data_dir: Path
    host: str
    port: int

    def find_user(self, username: str) -> User | None:
        for user in self.users:
            if user.username == username:
                return user
        return None


_settings: Settings | None = None


def load_settings() -> Settings:
    config_path = Path(os.environ.get("LITESYNC_CONFIG", "./config.yaml")).resolve()
    if not config_path.exists():
        raise FileNotFoundError(
            f"Config file not found at {config_path}. Copy config.example.yaml to "
            "config.yaml and edit it, or set LITESYNC_CONFIG."
        )

    with open(config_path) as f:
        raw = yaml.safe_load(f)

    allowed_roots = [Path(p).resolve() for p in raw["allowed_roots"]]
    users = [User(username=u["username"], password_hash=u["password_hash"]) for u in raw["users"]]
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
    )


def get_settings() -> Settings:
    global _settings
    if _settings is None:
        _settings = load_settings()
    return _settings
