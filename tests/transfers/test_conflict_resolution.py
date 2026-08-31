import os
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.transfers import db
from app.transfers.scheduler import _run_task
from app.transfers import engine_rsync, engine_kernel
from app.transfers.conflict import compute_next_available_name

@pytest.fixture(autouse=True)
def override_auth():
    from app.main import app
    from app.auth import get_current_user
    app.dependency_overrides[get_current_user] = lambda: "admin"
    yield
    app.dependency_overrides.clear()

@pytest.fixture
def test_client(temp_roots):
    from app.main import app
    with TestClient(app) as c:
        yield c

@pytest.fixture
def auth_cookies(test_client):
    return {}

@pytest.fixture
def temp_roots(tmp_path, monkeypatch):
    root1 = tmp_path / "root1"
    root2 = tmp_path / "root2"
    root1.mkdir()
    root2.mkdir()
    
    config_data = f'''
    secret_key = "test_secret_key"
    allowed_roots = ["{root1}", "{root2}"]
    
    [auth]
    users = [{{"username" = "admin", "password_hash" = "$2b$12$NqB8.V9.sQ9Q20aB6.Q23e0pX/2VfH2L6g.e52.H2YhP2.eY.W2."}}]
    '''
    conf_path = tmp_path / "config.toml"
    conf_path.write_text(config_data)
    
    db.init_db(tmp_path)
    db.clear_activity()
    
    monkeypatch.setenv("LITESYNC_CONFIG", str(conf_path))
    import app.config
    app.config._settings = None
    return root1, root2

@pytest.mark.asyncio
async def test_transfer_no_conflicts(temp_roots):
    root1, root2 = temp_roots
    src_file = root1 / "file.txt"
    src_file.write_text("hello")
    
    db.insert_task(id="test1", source=str(src_file), destination=str(root2), operation="copy", on_conflict="rename")
    task = db.get_task("test1")
    db.mark_running("test1")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    assert (root2 / "file.txt").exists()
    assert (root2 / "file.txt").read_text() == "hello"

@pytest.mark.asyncio
async def test_transfer_conflict_skip(temp_roots):
    root1, root2 = temp_roots
    src_file = root1 / "file.txt"
    src_file.write_text("hello")
    
    dst_file = root2 / "file.txt"
    dst_file.write_text("old")
    
    db.insert_task(id="test2", source=str(src_file), destination=str(root2), operation="copy", on_conflict="skip", use_rsync=False)
    task = db.get_task("test2")
    db.mark_running("test2")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    t = db.get_task("test2")
    assert t["status"] == "failed"
    assert dst_file.read_text() == "old"

@pytest.mark.asyncio
async def test_transfer_conflict_overwrite_file(temp_roots):
    root1, root2 = temp_roots
    src_file = root1 / "file.txt"
    src_file.write_text("hello")
    
    dst_file = root2 / "file.txt"
    dst_file.write_text("old")
    
    db.insert_task(id="test3", source=str(src_file), destination=str(root2), operation="copy", on_conflict="overwrite", use_rsync=False)
    task = db.get_task("test3")
    db.mark_running("test3")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    t = db.get_task("test3")
    assert t["status"] == "succeeded"
    assert dst_file.read_text() == "hello"

@pytest.mark.asyncio
async def test_transfer_conflict_overwrite_dir(temp_roots):
    root1, root2 = temp_roots
    src_dir = root1 / "dir1"
    src_dir.mkdir()
    (src_dir / "file.txt").write_text("hello")
    
    dst_dir = root2 / "dir1"
    dst_dir.mkdir()
    (dst_dir / "file.txt").write_text("old")
    (dst_dir / "keep.txt").write_text("keep")
    
    db.insert_task(id="test4", source=str(src_dir), destination=str(root2), operation="copy", on_conflict="overwrite", use_rsync=False)
    task = db.get_task("test4")
    db.mark_running("test4")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    t = db.get_task("test4")
    assert t["status"] == "succeeded"
    assert (dst_dir / "file.txt").read_text() == "hello"
    assert (dst_dir / "keep.txt").read_text() == "keep"

@pytest.mark.asyncio
async def test_transfer_conflict_rename_file(temp_roots):
    root1, root2 = temp_roots
    src_file = root1 / "file.txt"
    src_file.write_text("hello")
    
    dst_file = root2 / "file.txt"
    dst_file.write_text("old")
    
    db.insert_task(id="test5", source=str(src_file), destination=str(root2), operation="copy", on_conflict="rename", use_rsync=False)
    task = db.get_task("test5")
    db.mark_running("test5")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    t = db.get_task("test5")
    assert t["status"] == "succeeded"
    assert dst_file.read_text() == "old"
    assert (root2 / "file_1.txt").read_text() == "hello"

@pytest.mark.asyncio
async def test_transfer_conflict_rename_file_multiple(temp_roots):
    root1, root2 = temp_roots
    src_file = root1 / "file.txt"
    src_file.write_text("hello")
    
    (root2 / "file.txt").write_text("old")
    (root2 / "file_1.txt").write_text("old1")
    
    db.insert_task(id="test6", source=str(src_file), destination=str(root2), operation="copy", on_conflict="rename", use_rsync=False)
    task = db.get_task("test6")
    db.mark_running("test6")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    t = db.get_task("test6")
    assert t["status"] == "succeeded"
    assert (root2 / "file_2.txt").read_text() == "hello"

@pytest.mark.asyncio
async def test_transfer_conflict_rename_dir(temp_roots):
    root1, root2 = temp_roots
    src_dir = root1 / "dir1"
    src_dir.mkdir()
    (src_dir / "f.txt").write_text("f")
    
    (root2 / "dir1").mkdir()
    
    db.insert_task(id="test7", source=str(src_dir), destination=str(root2), operation="copy", on_conflict="rename", use_rsync=False)
    task = db.get_task("test7")
    db.mark_running("test7")
    
    from app.config import get_settings
    await _run_task(task, get_settings())
    
    t = db.get_task("test7")
    assert t["status"] == "succeeded"
    assert (root2 / "dir1_1").is_dir()
    assert (root2 / "dir1_1" / "f.txt").read_text() == "f"

@pytest.mark.asyncio
async def test_transfer_conflict_rename_sequential(temp_roots):
    root1, root2 = temp_roots
    src1 = root1 / "a" / "file.txt"
    src1.parent.mkdir()
    src1.write_text("one")
    
    src2 = root1 / "b" / "file.txt"
    src2.parent.mkdir()
    src2.write_text("two")
    
    (root2 / "file.txt").write_text("zero")
    
    db.insert_task(id="t1", source=str(src1), destination=str(root2), operation="copy", on_conflict="rename")
    db.insert_task(id="t2", source=str(src2), destination=str(root2), operation="copy", on_conflict="rename")
    
    from app.config import get_settings
    # Process sequentially as the scheduler would
    db.mark_running("t1")
    await _run_task(db.get_task("t1"), get_settings())
    
    db.mark_running("t2")
    await _run_task(db.get_task("t2"), get_settings())
    
    assert (root2 / "file_1.txt").read_text() == "one"
    assert (root2 / "file_2.txt").read_text() == "two"

@pytest.mark.asyncio
async def test_transfer_conflict_resolution_run_time(temp_roots):
    root1, root2 = temp_roots
    src = root1 / "file.txt"
    src.write_text("new")
    
    dst = root2 / "file.txt"
    dst.write_text("old")
    
    # Queue task while file exists
    db.insert_task(id="t3", source=str(src), destination=str(root2), operation="copy", on_conflict="rename")
    
    # Delete file before task runs
    dst.unlink()
    
    from app.config import get_settings
    db.mark_running("t3")
    await _run_task(db.get_task("t3"), get_settings())
    
    # Resolves at run-time -> file.txt is available now, shouldn't use file_1.txt
    assert dst.read_text() == "new"
    assert not (root2 / "file_1.txt").exists()

def test_upload_conflict_skip(temp_roots, auth_cookies, test_client):
    root1, root2 = temp_roots
    (root2 / "file.txt").write_text("old")
    
    response = test_client.post(
        "/api/upload",
        data={"path": str(root2), "on_conflict": "skip"},
        files={"files": ("file.txt", b"new", "text/plain")},
        cookies=auth_cookies
    )
    assert response.status_code == 400
    assert "already exists" in response.json()["detail"]
    assert (root2 / "file.txt").read_text() == "old"

def test_upload_conflict_overwrite(temp_roots, auth_cookies, test_client):
    root1, root2 = temp_roots
    (root2 / "file.txt").write_text("old")
    
    response = test_client.post(
        "/api/upload",
        data={"path": str(root2), "on_conflict": "overwrite"},
        files={"files": ("file.txt", b"new", "text/plain")},
        cookies=auth_cookies
    )
    assert response.status_code == 200
    assert (root2 / "file.txt").read_text() == "new"

def test_upload_conflict_rename(temp_roots, auth_cookies, test_client):
    root1, root2 = temp_roots
    (root2 / "file.txt").write_text("old")
    
    response = test_client.post(
        "/api/upload",
        data={"path": str(root2), "on_conflict": "rename"},
        files={"files": ("file.txt", b"new", "text/plain")},
        cookies=auth_cookies
    )
    assert response.status_code == 200
    assert (root2 / "file.txt").read_text() == "old"
    assert (root2 / "file_1.txt").read_text() == "new"


def test_upload_overwrite_mid_stream_disconnect(temp_roots, auth_cookies, test_client):
    from unittest.mock import patch
    from starlette.requests import ClientDisconnect
    
    root1, root2 = temp_roots
    dest = root2 / "dest"
    dest.mkdir()
    target_file = dest / "file.txt"
    target_file.write_text("original content")

    async def mock_read(self, size=-1):
        raise ClientDisconnect()

    with patch("app.browse.upload.UploadFile.read", new=mock_read):
        response = test_client.post(
            "/api/upload",
            data={"path": str(dest), "on_conflict": "overwrite"},
            files={"files": ("file.txt", b"new content", "text/plain")},
            cookies=auth_cookies
        )
    
    assert response.status_code == 499
    # The original file must still exist and be exactly as it was
    assert target_file.exists()
    assert target_file.read_text() == "original content"
    
    # Check that no temp files were left behind
    temp_files = list(dest.glob(".litesync-upload-*.tmp"))
    assert len(temp_files) == 0
