import os
import tempfile
import subprocess
from pathlib import Path
import pytest
from fastapi.testclient import TestClient

from app.main import app as fastapi_app
from app.config import get_settings, load_settings
from app.auth import hash_password, create_session_cookie
from app.transfers import db


@pytest.fixture
def test_env():
    with tempfile.TemporaryDirectory() as temp_dir:
        temp_path = Path(temp_dir)
        allowed_root = temp_path / "allowed_root"
        allowed_root.mkdir(parents=True, exist_ok=True)
        data_dir = temp_path / "data"
        data_dir.mkdir(parents=True, exist_ok=True)

        db.init_db(data_dir)

        initial_hash = hash_password("testpassword123")
        config_path = temp_path / "config.toml"
        config_content = f"""
allowed_roots = ["{allowed_root}"]
secret_key = "test_secret_for_hidden_files_test"
data_dir = "{data_dir}"

[[users]]
username = "testuser"
password_hash = "{initial_hash}"
"""
        config_path.write_text(config_content)
        os.environ["LITESYNC_CONFIG"] = str(config_path)

        import app.config
        app.config._settings = None
        settings = load_settings(config_path)
        app.config._settings = settings

        client = TestClient(fastapi_app)
        login_resp = client.post("/api/login", json={"username": "testuser", "password": "testpassword123"})
        assert login_resp.status_code == 200
        client.cookies.set("litesync_session", login_resp.cookies.get("litesync_session"))

        yield {
            "root": allowed_root,
            "client": client,
            "settings": settings,
        }

        app.config._settings = None
        os.environ.pop("LITESYNC_CONFIG", None)


def test_browse_returns_dotfiles_unfiltered(test_env):
    """Confirm GET /api/browse response includes dot-files without backend filtering."""
    root = test_env["root"]
    client = test_env["client"]

    # Create mixed directory contents
    (root / ".bashrc").write_text("export FOO=bar")
    (root / ".config").mkdir()
    (root / ".config" / "app.conf").write_text("setting=1")
    (root / "documents").mkdir()
    (root / "notes.txt").write_text("hello world")

    res = client.get(f"/api/browse?path={root}")
    assert res.status_code == 200
    data = res.json()

    entry_names = [e["name"] for e in data["entries"]]
    assert ".bashrc" in entry_names, "Backend /api/browse must include hidden dotfile"
    assert ".config" in entry_names, "Backend /api/browse must include hidden dot-directory"
    assert "documents" in entry_names
    assert "notes.txt" in entry_names

    bashrc_entry = next(e for e in data["entries"] if e["name"] == ".bashrc")
    assert bashrc_entry["is_dir"] is False
    assert bashrc_entry["size"] > 0

    config_entry = next(e for e in data["entries"] if e["name"] == ".config")
    assert config_entry["is_dir"] is True


def test_direct_navigation_to_hidden_folder(test_env):
    """Confirm directly browsing into a dot-directory works seamlessly."""
    root = test_env["root"]
    client = test_env["client"]

    hidden_dir = root / ".hidden_project"
    hidden_dir.mkdir()
    (hidden_dir / "file1.txt").write_text("data")
    (hidden_dir / ".nested_secret").write_text("secret")

    res = client.get(f"/api/browse?path={hidden_dir}")
    assert res.status_code == 200
    data = res.json()

    assert data["path"] == str(hidden_dir)
    assert data["parent"] == str(root)
    entry_names = [e["name"] for e in data["entries"]]
    assert "file1.txt" in entry_names
    assert ".nested_secret" in entry_names


def test_backend_operations_on_hidden_files_unrestricted(test_env):
    """Regression check confirming backend operations on dot-files work normally with zero restrictions."""
    root = test_env["root"]
    client = test_env["client"]

    # 1. mkdir with dot-name
    res = client.post("/api/mkdir", json={"path": str(root), "name": ".new_hidden_folder"})
    assert res.status_code == 200
    assert (root / ".new_hidden_folder").is_dir()

    # 2. create/edit file in dot-folder
    target_file = root / ".new_hidden_folder" / ".secret.txt"
    target_file.write_text("initial")
    stat = target_file.stat()

    res = client.post(
        "/api/file-content",
        json={
            "path": str(target_file),
            "content": "updated secret content",
            "expected_mtime_ns": str(stat.st_mtime_ns),
        },
    )
    assert res.status_code == 200
    assert target_file.read_text() == "updated secret content"

    # 3. rename dot-file
    res = client.post(
        "/api/rename",
        json={"path": str(target_file), "new_name": ".renamed_secret.txt"},
    )
    assert res.status_code == 200
    renamed_path = root / ".new_hidden_folder" / ".renamed_secret.txt"
    assert renamed_path.exists()
    assert not target_file.exists()

    # 4. delete dot-folder and dot-files
    res = client.post("/api/delete", json={"path": str(root / ".new_hidden_folder")})
    assert res.status_code == 200
    assert not (root / ".new_hidden_folder").exists()


def test_zero_backend_changes():
    """Verify that zero files in app/ were modified for this frontend-only feature."""
    repo_root = Path(__file__).resolve().parents[2]
    diff = subprocess.check_output(["git", "diff", "--name-only", "app/"], cwd=repo_root, text=True)
    assert diff.strip() == "", f"Expected zero backend modifications in app/, but found: {diff}"
