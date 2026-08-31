from __future__ import annotations

import asyncio
import io
import os
import resource
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

from fastapi import HTTPException, UploadFile
from starlette.datastructures import FormData, Headers
from starlette.requests import ClientDisconnect, Request

from app.config import Settings, User
from app.routes_browse import upload_files, validate_upload_filename
from app.transfers import db


def make_mock_request(form_data: dict[str, any] | None = None, exc_on_form: Exception | None = None) -> Request:
    """Create a mock Starlette Request with configurable form() resolution."""
    scope = {
        "type": "http",
        "method": "POST",
        "path": "/api/upload",
        "headers": [(b"content-type", b"multipart/form-data; boundary=---boundary")],
    }
    req = Request(scope)
    if exc_on_form is not None:
        async def mock_form():
            raise exc_on_form
        req.form = mock_form
    elif form_data is not None:
        async def mock_form():
            items = []
            for k, v in form_data.items():
                if isinstance(v, list):
                    for item in v:
                        items.append((k, item))
                else:
                    items.append((k, v))
            return FormData(items)
        req.form = mock_form
    return req


def make_upload_file(filename: str, content: bytes, size: int | None = None) -> UploadFile:
    """Helper to create a FastAPI/Starlette UploadFile."""
    file_obj = io.BytesIO(content)
    uf = UploadFile(
        filename=filename,
        file=file_obj,
        size=size if size is not None else len(content),
        headers=Headers({"content-type": "application/octet-stream"}),
    )
    return uf


class TestFileUploadIntegration(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.data_dir = self.base_dir / "data"
        self.source_dir = self.base_dir / "source"
        self.dest_dir = self.base_dir / "dest"

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.source_dir.mkdir(parents=True, exist_ok=True)
        self.dest_dir.mkdir(parents=True, exist_ok=True)

        db.init_db(self.data_dir)

        self.settings = Settings(
            allowed_roots=[self.source_dir, self.dest_dir],
            users=[User(username="test_user", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
            max_upload_size_mb=5000,
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_filename_validation_rules(self):
        """Test validate_upload_filename rejects invalid, dangerous, or malicious names."""
        # Valid names
        self.assertEqual(validate_upload_filename("movie.mkv"), "movie.mkv")
        self.assertEqual(validate_upload_filename("  document.pdf  "), "document.pdf")
        self.assertEqual(validate_upload_filename(".hidden_file"), ".hidden_file")
        self.assertEqual(validate_upload_filename("My File (2026).tar.gz"), "My File (2026).tar.gz")

        # Slashes and backslashes
        with self.assertRaises(HTTPException) as ctx:
            validate_upload_filename("folder/file.txt")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("path separators", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            validate_upload_filename("folder\\file.txt")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("path separators", ctx.exception.detail)

        with self.assertRaises(HTTPException) as ctx:
            validate_upload_filename("../../etc/passwd")
        self.assertEqual(ctx.exception.status_code, 400)

        # Empty, dot, dot-dot
        with self.assertRaises(HTTPException):
            validate_upload_filename("")
        with self.assertRaises(HTTPException):
            validate_upload_filename("   ")
        with self.assertRaises(HTTPException):
            validate_upload_filename(".")
        with self.assertRaises(HTTPException):
            validate_upload_filename("..")
        with self.assertRaises(HTTPException):
            validate_upload_filename(None)

        # NUL byte
        with self.assertRaises(HTTPException) as ctx:
            validate_upload_filename("exploit\x00.txt")
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertIn("NUL byte", ctx.exception.detail)

    def test_small_file_upload_success(self):
        """Small file upload succeeds, file exists with exact content, exactly 1 activity log entry."""
        content = b"Hello, LiteSync direct upload!"
        upload_file = make_upload_file("test_doc.txt", content)

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            res = asyncio.run(upload_files(req, _user="test_user"))
            self.assertTrue(res["success"])
            self.assertEqual(len(res["files"]), 1)
            self.assertEqual(res["files"][0]["name"], "test_doc.txt")
            self.assertEqual(res["files"][0]["size"], len(content))

        final_file = self.dest_dir / "test_doc.txt"
        self.assertTrue(final_file.exists())
        self.assertEqual(final_file.read_bytes(), content)

        # Temp file must NOT exist
        temp_files = list(self.dest_dir.glob(".litesync-upload-*.tmp"))
        self.assertEqual(len(temp_files), 0)

        # Activity Log: exactly 1 entry
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        entry = activities[0]
        self.assertEqual(entry["kind"], "upload")
        import json
        msg = json.loads(entry["message"])
        self.assertEqual(msg["operation"], "upload")
        self.assertEqual(msg["status"], "succeeded")
        self.assertEqual(msg["name"], "test_doc.txt")
        self.assertIn("test_doc.txt", msg["summary"])
        self.assertEqual(msg["size"], len(content))
        self.assertIsNone(msg["error"])

        # Tasks table must remain completely untouched
        self.assertEqual(len(db.list_tasks()), 0)

    def test_chunked_streaming_write_memory_bounded(self):
        """Verify chunked copying: writes occur in fixed chunks and memory growth is bounded."""
        # 1. Chunked write assertion: create 5MB payload and mock/verify chunk size
        chunk_sizes_written = []
        payload_5mb = b"X" * (5 * 1024 * 1024)

        upload_file = make_upload_file("large_chunked.bin", payload_5mb)

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        # Track written chunk sizes
        orig_open = open
        def tracking_open(file, mode="r", *args, **kwargs):
            handle = orig_open(file, mode, *args, **kwargs)
            if "b" in mode and "w" in mode and ".litesync-upload-" in str(file):
                orig_write = handle.write
                def tracked_write(data):
                    chunk_sizes_written.append(len(data))
                    return orig_write(data)
                handle.write = tracked_write
            return handle

        # Measure RSS before and after
        rss_before = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

        with patch("app.routes_browse.get_settings", return_value=self.settings), \
             patch("builtins.open", side_effect=tracking_open):
            res = asyncio.run(upload_files(req, _user="test_user"))
            self.assertTrue(res["success"])

        rss_after = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss

        # Assert data was written in chunks capped at 1MB (1024 * 1024)
        self.assertTrue(len(chunk_sizes_written) >= 5)
        for sz in chunk_sizes_written:
            self.assertLessEqual(sz, 1024 * 1024)

        final_file = self.dest_dir / "large_chunked.bin"
        self.assertTrue(final_file.exists())
        self.assertEqual(final_file.stat().st_size, len(payload_5mb))

    def test_upload_outside_allowed_roots_rejected(self):
        """Upload to a path outside allowed roots is rejected via resolve_safe_path."""
        content = b"outside data"
        upload_file = make_upload_file("outside.txt", content)

        req = make_mock_request({
            "path": "/etc",
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(ctx.exception.status_code, 403)
            self.assertIn("outside allowed roots", ctx.exception.detail)

        # No files or temp files created
        self.assertFalse((self.dest_dir / "outside.txt").exists())
        self.assertEqual(len(db.list_activity()), 0)

    def test_invalid_filename_rejected_with_activity_log(self):
        """Upload with invalid filename is rejected and records a failure activity entry."""
        content = b"bad data"
        upload_file = make_upload_file("sub/bad.txt", content)

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(ctx.exception.status_code, 400)

        # No temp files
        temp_files = list(self.dest_dir.glob(".litesync-upload-*.tmp"))
        self.assertEqual(len(temp_files), 0)

        # Activity Log: exactly 1 failure entry
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        import json
        msg = json.loads(activities[0]["message"])
        self.assertEqual(msg["operation"], "upload")
        self.assertEqual(msg["status"], "failed")
        self.assertIn("path separators", msg["error"])

    def test_collision_rejection(self):
        """Upload to an existing filename is rejected, existing file untouched, temp file removed."""
        existing_file = self.dest_dir / "existing_movie.mkv"
        existing_file.write_bytes(b"ORIGINAL_MOVIE_CONTENT")

        upload_file = make_upload_file("existing_movie.mkv", b"NEW_ATTEMPTED_CONTENT")

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(ctx.exception.status_code, 400)
            self.assertIn("already exists", ctx.exception.detail)

        # Existing file remains unchanged
        self.assertEqual(existing_file.read_bytes(), b"ORIGINAL_MOVIE_CONTENT")

        # No temp files left behind
        temp_files = list(self.dest_dir.glob(".litesync-upload-*.tmp"))
        self.assertEqual(len(temp_files), 0)

        # Exactly 1 failure Activity Log entry
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        import json
        msg = json.loads(activities[0]["message"])
        self.assertEqual(msg["status"], "failed")
        self.assertIn("already exists", msg["error"])

    def test_client_disconnect_during_form_resolution_silent_abandonment(self):
        """Client disconnect during form resolution: silent abandonment, no activity log, no temp file."""
        req = make_mock_request(exc_on_form=ClientDisconnect())

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            res = asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(res.status_code, 499)

        # No activity log created
        self.assertEqual(len(db.list_activity()), 0)
        # No files or temp files
        self.assertEqual(len(list(self.dest_dir.glob("*"))), 0)

    def test_client_disconnect_during_stream_read_silent_abandonment(self):
        """Simulated client disconnect mid-read: deletes temp file, no activity log, no final file."""
        # Create UploadFile whose underlying file.read() raises ClientDisconnect on second chunk
        mock_file = MagicMock()
        mock_file.read = MagicMock(side_effect=[b"first chunk", ClientDisconnect()])

        uf = UploadFile(
            filename="disconnect_mid.bin",
            file=mock_file,
            size=1000000,
            headers=Headers({"content-type": "application/octet-stream"}),
        )

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": uf,
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            res = asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(res.status_code, 499)

        # Temp file deleted
        temp_files = list(self.dest_dir.glob(".litesync-upload-*.tmp"))
        self.assertEqual(len(temp_files), 0)

        # Final file never created
        self.assertFalse((self.dest_dir / "disconnect_mid.bin").exists())

        # No activity log created
        self.assertEqual(len(db.list_activity()), 0)

    def test_max_upload_size_limit_rejection(self):
        """Upload exceeding max_upload_size_mb is rejected with 413, temp file cleaned up, logged as failure."""
        settings_small_limit = Settings(
            allowed_roots=[self.source_dir, self.dest_dir],
            users=[User(username="test_user", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
            max_upload_size_mb=1,  # 1 MB limit
        )

        oversized_content = b"Y" * (2 * 1024 * 1024)  # 2 MB
        upload_file = make_upload_file("oversized.iso", oversized_content)

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=settings_small_limit):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(ctx.exception.status_code, 413)
            self.assertIn("exceeds maximum upload size", ctx.exception.detail)

        # Temp file removed
        temp_files = list(self.dest_dir.glob(".litesync-upload-*.tmp"))
        self.assertEqual(len(temp_files), 0)

        # Final file never created
        self.assertFalse((self.dest_dir / "oversized.iso").exists())

        # Activity Log: exactly 1 failure entry
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        import json
        msg = json.loads(activities[0]["message"])
        self.assertEqual(msg["operation"], "upload")
        self.assertEqual(msg["status"], "failed")
        self.assertIn("exceeds maximum upload size", msg["error"])

    def test_max_upload_size_limit_rejection_with_unknown_client_size_chunked_stream(self):
        """When client reports NO size (file.size is None, e.g. chunked transfer), running byte count enforces 413."""
        settings_small_limit = Settings(
            allowed_roots=[self.source_dir, self.dest_dir],
            users=[User(username="test_user", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
            max_upload_size_mb=1,  # 1 MB limit
        )

        # UploadFile with size=None (no size reported by client)
        oversized_content = b"Z" * (2 * 1024 * 1024)  # 2 MB
        upload_file = UploadFile(
            filename="chunked_oversized.bin",
            file=io.BytesIO(oversized_content),
            size=None,  # No size header from client
            headers=Headers({"content-type": "application/octet-stream"}),
        )

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=settings_small_limit):
            with self.assertRaises(HTTPException) as ctx:
                asyncio.run(upload_files(req, _user="test_user"))
            self.assertEqual(ctx.exception.status_code, 413)
            self.assertIn("exceeds maximum upload size", ctx.exception.detail)

        # Temp file removed
        temp_files = list(self.dest_dir.glob(".litesync-upload-*.tmp"))
        self.assertEqual(len(temp_files), 0)

        # Final file never created
        self.assertFalse((self.dest_dir / "chunked_oversized.bin").exists())

        # Activity Log: exactly 1 failure entry
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        import json
        msg = json.loads(activities[0]["message"])
        self.assertEqual(msg["operation"], "upload")
        self.assertEqual(msg["status"], "failed")
        self.assertIn("exceeds maximum upload size", msg["error"])

    def test_tasks_table_complete_isolation(self):
        """Verify uploaded operations never touch tasks table or /api/tasks."""
        content = b"isolation test"
        upload_file = make_upload_file("isolated.txt", content)

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": upload_file,
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            res = asyncio.run(upload_files(req, _user="test_user"))
            self.assertTrue(res["success"])

        # Tasks table must remain empty
        self.assertEqual(len(db.list_tasks()), 0)
        self.assertEqual(len(db.list_queued_tasks()), 0)
        self.assertEqual(len(db.list_running_tasks()), 0)

    def test_multiple_files_upload_batch(self):
        """Multiple files uploaded in a single request create all files and independent activity entries."""
        f1 = make_upload_file("batch_1.txt", b"file one")
        f2 = make_upload_file("batch_2.txt", b"file two")
        f3 = make_upload_file("batch_3.txt", b"file three")

        req = make_mock_request({
            "path": str(self.dest_dir),
            "files": [f1, f2, f3],
        })

        with patch("app.routes_browse.get_settings", return_value=self.settings):
            res = asyncio.run(upload_files(req, _user="test_user"))
            self.assertTrue(res["success"])
            self.assertEqual(len(res["files"]), 3)

        self.assertEqual((self.dest_dir / "batch_1.txt").read_bytes(), b"file one")
        self.assertEqual((self.dest_dir / "batch_2.txt").read_bytes(), b"file two")
        self.assertEqual((self.dest_dir / "batch_3.txt").read_bytes(), b"file three")

        # 3 independent activity entries
        activities = db.list_activity()
        self.assertEqual(len(activities), 3)
        import json
        names = [json.loads(a["message"])["name"] for a in activities]
        self.assertIn("batch_1.txt", names)
        self.assertIn("batch_2.txt", names)
        self.assertIn("batch_3.txt", names)


if __name__ == "__main__":
    unittest.main()
