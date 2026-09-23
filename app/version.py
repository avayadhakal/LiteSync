from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger("litesync")

VERSION_FILE = Path(__file__).resolve().parent.parent / "VERSION"
FALLBACK_VERSION = "dev"


def read_version_file(path: Path = VERSION_FILE) -> str:
    """Read the version string from the VERSION file.

    Returns FALLBACK_VERSION ('dev') if the file is missing, empty, or unreadable.
    Catches all exceptions so application startup is never blocked.
    """
    try:
        if path.is_file():
            content = path.read_text(encoding="utf-8").strip()
            if content:
                return content.splitlines()[0].strip()
    except Exception as exc:
        logger.warning("Could not read VERSION file at %s: %s", path, exc)
    return FALLBACK_VERSION


APP_VERSION: str = read_version_file()


def get_app_version() -> str:
    """Return the cached in-memory application version string."""
    return APP_VERSION
