from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import pytest
from starlette.testclient import TestClient

from app.auth import create_session_cookie
from app.config import get_settings
from app.main import app
from app.version import FALLBACK_VERSION, get_app_version, read_version_file


def test_version_file_reading_success():
    with tempfile.TemporaryDirectory() as tmpdir:
        vfile = Path(tmpdir) / "VERSION"
        vfile.write_text("0.1.0-beta\n", encoding="utf-8")
        assert read_version_file(vfile) == "0.1.0-beta"

        # Trailing newlines / whitespace stripped
        vfile.write_text("  1.2.3-rc1  \n\n", encoding="utf-8")
        assert read_version_file(vfile) == "1.2.3-rc1"


def test_version_file_missing_graceful_fallback():
    non_existent = Path("/path/to/definitely/nonexistent/VERSION")
    assert read_version_file(non_existent) == FALLBACK_VERSION


def test_version_file_empty_graceful_fallback():
    with tempfile.TemporaryDirectory() as tmpdir:
        vfile = Path(tmpdir) / "VERSION"
        vfile.write_text("   \n\n", encoding="utf-8")
        assert read_version_file(vfile) == FALLBACK_VERSION


def test_version_file_unreadable_graceful_fallback():
    with tempfile.TemporaryDirectory() as tmpdir:
        vfile = Path(tmpdir) / "VERSION"
        vfile.write_text("0.1.0-beta", encoding="utf-8")
        vfile.chmod(0o000)
        # Even if read_text raises PermissionError, fallback is returned safely
        assert read_version_file(vfile) == FALLBACK_VERSION
        vfile.chmod(0o644)


def test_api_version_endpoint():
    client = TestClient(app)
    resp = client.get("/api/version")
    assert resp.status_code == 200
    data = resp.json()
    assert "version" in data
    assert data["version"] == get_app_version()
    assert data["version"] == "0.1.0-beta"


def test_api_whoami_includes_version():
    settings = get_settings()
    user = settings.users[0]
    cookie = create_session_cookie(user.username, user.password_hash)

    client = TestClient(app)
    resp = client.get("/api/whoami", cookies={"litesync_session": cookie})
    assert resp.status_code == 200
    data = resp.json()
    assert data["username"] == user.username
    assert data["version"] == get_app_version()
    assert data["version"] == "0.1.0-beta"


def test_version_read_once_at_startup_not_per_request():
    client = TestClient(app)

    # Patch Path.read_text so any disk read attempt raises an assertion or is tracked
    with patch.object(Path, "read_text", side_effect=AssertionError("Disk read occurred during request!")):
        for _ in range(5):
            resp = client.get("/api/version")
            assert resp.status_code == 200
            assert resp.json()["version"] == "0.1.0-beta"
