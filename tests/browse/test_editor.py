from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.parse import quote

import pytest

from app.auth import create_session_cookie
from app.config import Settings, User, load_settings
from app.main import app
from app.transfers import db
from tests.browse.test_download import make_request


class TestEditorEndpoints(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root_dir = Path(self.temp_dir.name) / "allowed_root"
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.outside_dir = Path(self.temp_dir.name) / "outside"
        self.outside_dir.mkdir(parents=True, exist_ok=True)
        self.data_dir = Path(self.temp_dir.name) / "data"
        self.data_dir.mkdir(parents=True, exist_ok=True)

        db.init_db(self.data_dir)

        self.config_file = Path(self.temp_dir.name) / "config.toml"
        config_content = f"""
allowed_roots = ["{self.root_dir}"]
secret_key = "test_master_secret_key_for_litesync"
session_max_age = 3600
download_expiry = 7200
data_dir = "{self.data_dir}"
host = "127.0.0.1"
port = 8000

[[users]]
username = "pi"
password_hash = "$2b$12$e8uq..."
"""
        self.config_file.write_text(config_content)
        self.old_env = os.environ.get("LITESYNC_CONFIG")
        os.environ["LITESYNC_CONFIG"] = str(self.config_file)

        import app.config

        app.config._settings = None
        self.settings = load_settings(self.config_file)
        app.config._settings = self.settings

        self.session_cookie = create_session_cookie("pi")

    def tearDown(self):
        if self.old_env is not None:
            os.environ["LITESYNC_CONFIG"] = self.old_env
        else:
            os.environ.pop("LITESYNC_CONFIG", None)
        import app.config

        app.config._settings = None
        self.temp_dir.cleanup()

    def test_get_file_content_success(self):
        """Test GET /api/file-content returns 200 with text and exact string mtime_ns for small allowlisted file."""
        sample_file = self.root_dir / "config.toml"
        content = "title = 'LiteSync Config'\nport = 8000\n"
        sample_file.write_text(content, encoding="utf-8")

        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/file-content",
                query_string=f"path={quote(str(sample_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        import json

        data = json.loads(body.decode("utf-8"))
        self.assertEqual(data["content"], content)
        self.assertEqual(data["mtime_ns"], str(sample_file.stat().st_mtime_ns))
        self.assertEqual(data["path"], str(sample_file))

    def test_get_file_content_non_utf8_binary_rejected_400(self):
        """Test GET /api/file-content rejects invalid UTF-8 (e.g. binary JPEG data in .txt file) with 400."""
        binary_txt = self.root_dir / "fake_text.txt"
        binary_txt.write_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF\x00\x01\x01\x00\x00\x01")

        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/file-content",
                query_string=f"path={quote(str(binary_txt))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 400)
        self.assertIn(b"not valid utf-8", body.lower())

    def test_get_file_content_unallowlisted_ext_rejected_400(self):
        """Test GET /api/file-content independently rejects unallowlisted extensions (.mp4, .jpg, .bin) with 400."""
        for name in ["video.mp4", "image.jpg", "program.bin", "archive.zip"]:
            bad_file = self.root_dir / name
            bad_file.write_bytes(b"some content")

            status, _, body = asyncio.run(
                make_request(
                    "GET",
                    "/api/file-content",
                    query_string=f"path={quote(str(bad_file))}",
                    headers=[("Cookie", f"litesync_session={self.session_cookie}")],
                )
            )
            self.assertEqual(status, 400)
            self.assertIn(b"not supported for editing", body.lower())

    def test_get_file_content_oversized_rejected_413(self):
        """Test GET /api/file-content rejects text files > 2MB with 413."""
        big_file = self.root_dir / "large.log"
        big_file.write_bytes(b"A" * (2 * 1024 * 1024 + 10))

        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/file-content",
                query_string=f"path={quote(str(big_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 413)
        self.assertIn(b"exceeds maximum editable size", body.lower())

    def test_get_file_content_path_traversal_rejected_403(self):
        """Test GET /api/file-content rejects outside files and traversal attempts with 403."""
        outside_file = self.outside_dir / "secret.env"
        outside_file.write_text("API_KEY=12345")

        status, _, _ = asyncio.run(
            make_request(
                "GET",
                "/api/file-content",
                query_string=f"path={quote(str(outside_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 403)

    def test_post_file_content_success_updates_file_and_logs_activity(self):
        """Test POST /api/file-content saves new content, updates mtime_ns, and logs activity."""
        target_file = self.root_dir / "script.py"
        target_file.write_text("print('hello')", encoding="utf-8")
        orig_mtime_ns = str(target_file.stat().st_mtime_ns)

        new_content = "print('hello world updated')\n"
        import json

        payload = json.dumps(
            {
                "path": str(target_file),
                "content": new_content,
                "expected_mtime_ns": orig_mtime_ns,
            }
        ).encode("utf-8")

        status, _, body = asyncio.run(
            make_request(
                "POST",
                "/api/file-content",
                headers=[
                    ("Cookie", f"litesync_session={self.session_cookie}"),
                    ("Content-Type", "application/json"),
                ],
                body=payload,
            )
        )
        self.assertEqual(status, 200)
        data = json.loads(body.decode("utf-8"))
        self.assertTrue(data["success"])
        self.assertEqual(target_file.read_text(encoding="utf-8"), new_content)
        self.assertIsInstance(data["mtime_ns"], str)
        self.assertEqual(data["mtime_ns"], str(target_file.stat().st_mtime_ns))

        # Verify exactly one activity log entry created
        activities = db.list_activity()
        self.assertEqual(len(activities), 1)
        entry = activities[0]
        self.assertEqual(entry["kind"], "edit")
        msg = json.loads(entry["message"])
        self.assertEqual(msg["operation"], "edit")
        self.assertEqual(msg["status"], "succeeded")
        self.assertEqual(msg["name"], "script.py")
        self.assertEqual(msg["path"], str(target_file))
        self.assertEqual(msg["destination"], str(self.root_dir))
        self.assertEqual(msg["summary"], f"script.py → {self.root_dir}")

    def test_consecutive_saves_in_same_session(self):
        """Test opening a file and saving it twice in a row in the same session."""
        target_file = self.root_dir / "consecutive.txt"
        target_file.write_text("v1", encoding="utf-8")

        # 1. GET initial content
        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/file-content",
                query_string=f"path={quote(str(target_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        import json
        get_data = json.loads(body.decode("utf-8"))
        mtime1 = get_data["mtime_ns"]

        # 2. Save 1
        payload1 = json.dumps({
            "path": str(target_file),
            "content": "v2",
            "expected_mtime_ns": mtime1,
        }).encode("utf-8")
        status, _, body1 = asyncio.run(
            make_request(
                "POST",
                "/api/file-content",
                headers=[
                    ("Cookie", f"litesync_session={self.session_cookie}"),
                    ("Content-Type", "application/json"),
                ],
                body=payload1,
            )
        )
        self.assertEqual(status, 200)
        res1 = json.loads(body1.decode("utf-8"))
        mtime2 = res1["mtime_ns"]
        self.assertEqual(target_file.read_text(encoding="utf-8"), "v2")

        # 3. Save 2 immediately with updated mtime2
        payload2 = json.dumps({
            "path": str(target_file),
            "content": "v3",
            "expected_mtime_ns": mtime2,
        }).encode("utf-8")
        status, _, body2 = asyncio.run(
            make_request(
                "POST",
                "/api/file-content",
                headers=[
                    ("Cookie", f"litesync_session={self.session_cookie}"),
                    ("Content-Type", "application/json"),
                ],
                body=payload2,
            )
        )
        self.assertEqual(status, 200)
        res2 = json.loads(body2.decode("utf-8"))
        self.assertEqual(target_file.read_text(encoding="utf-8"), "v3")
        self.assertEqual(res2["mtime_ns"], str(target_file.stat().st_mtime_ns))

    def test_post_file_content_stale_mtime_conflict_409(self):
        """Test POST /api/file-content rejects stale mtime with 409 and does NOT overwrite disk content."""
        target_file = self.root_dir / "notes.md"
        target_file.write_text("# Initial Content", encoding="utf-8")
        orig_mtime_ns = str(target_file.stat().st_mtime_ns)

        # Simulate concurrent modification by external process
        time.sleep(0.01)
        target_file.write_text("# Externally Modified Content", encoding="utf-8")
        actual_mtime_ns = str(target_file.stat().st_mtime_ns)
        self.assertNotEqual(orig_mtime_ns, actual_mtime_ns)

        # Attempt to save with original stale mtime_ns
        import json

        payload = json.dumps(
            {
                "path": str(target_file),
                "content": "# Stale Editor Content",
                "expected_mtime_ns": orig_mtime_ns,
            }
        ).encode("utf-8")

        status, _, body = asyncio.run(
            make_request(
                "POST",
                "/api/file-content",
                headers=[
                    ("Cookie", f"litesync_session={self.session_cookie}"),
                    ("Content-Type", "application/json"),
                ],
                body=payload,
            )
        )
        self.assertEqual(status, 409)
        self.assertIn(b"modified since it was opened", body.lower())

        # Assert disk content was NOT overwritten
        self.assertEqual(target_file.read_text(encoding="utf-8"), "# Externally Modified Content")

    def test_19_digit_mtime_ns_exact_precision_round_trip(self):
        """Assert that 19-digit nanosecond timestamps survive string transport without JS Number precision loss."""
        # A 19-digit nanosecond integer exceeding Number.MAX_SAFE_INTEGER (9007199254740991)
        large_mtime_ns_str = "1788393805530634324"
        self.assertGreater(int(large_mtime_ns_str), 9007199254740991)

        import json
        # Serialized as string from backend
        payload_from_backend = json.dumps({"mtime_ns": large_mtime_ns_str})
        
        # Parsed and sent back by frontend as string
        frontend_parsed = json.loads(payload_from_backend)
        self.assertEqual(frontend_parsed["mtime_ns"], large_mtime_ns_str)
        
        frontend_post = json.dumps({
            "path": "/dummy/path.txt",
            "content": "test",
            "expected_mtime_ns": frontend_parsed["mtime_ns"]
        })

        # Deserialized by backend
        from app.browse.editor import FileEditRequest
        req = FileEditRequest.model_validate_json(frontend_post)
        self.assertEqual(req.expected_mtime_ns, large_mtime_ns_str)
        self.assertEqual(int(req.expected_mtime_ns), 1788393805530634324)

    def test_post_file_content_atomic_rename_mechanism(self):
        """Test POST /api/file-content writes to .litesync-edit-*.tmp and calls os.rename atomically."""
        target_file = self.root_dir / "document.txt"
        target_file.write_text("old text", encoding="utf-8")
        mtime_ns = str(target_file.stat().st_mtime_ns)

        import json

        payload = json.dumps(
            {
                "path": str(target_file),
                "content": "new text",
                "expected_mtime_ns": mtime_ns,
            }
        ).encode("utf-8")

        with patch("os.rename", wraps=os.rename) as mock_rename:
            status, _, _ = asyncio.run(
                make_request(
                    "POST",
                    "/api/file-content",
                    headers=[
                        ("Cookie", f"litesync_session={self.session_cookie}"),
                        ("Content-Type", "application/json"),
                    ],
                    body=payload,
                )
            )
            self.assertEqual(status, 200)
            mock_rename.assert_called_once()
            src_arg, dst_arg = mock_rename.call_args[0]
            src_path = Path(src_arg)
            dst_path = Path(dst_arg)

            self.assertTrue(src_path.name.startswith(".litesync-edit-"))
            self.assertTrue(src_path.name.endswith(".tmp"))
            self.assertEqual(src_path.parent, target_file.parent)
            self.assertEqual(dst_path.resolve(), target_file.resolve())

    def test_post_file_content_unallowlisted_and_oversized_rejected(self):
        """Test POST /api/file-content rejects unallowlisted extensions and oversized payloads independently."""
        bad_file = self.root_dir / "test.exe"
        bad_file.write_bytes(b"binary")
        mtime_ns = str(bad_file.stat().st_mtime_ns)

        import json

        # Unallowlisted extension
        payload_bad_ext = json.dumps(
            {
                "path": str(bad_file),
                "content": "bad ext content",
                "expected_mtime_ns": mtime_ns,
            }
        ).encode("utf-8")

        status, _, _ = asyncio.run(
            make_request(
                "POST",
                "/api/file-content",
                headers=[
                    ("Cookie", f"litesync_session={self.session_cookie}"),
                    ("Content-Type", "application/json"),
                ],
                body=payload_bad_ext,
            )
        )
        self.assertEqual(status, 400)

        # Oversized payload (>2MB)
        txt_file = self.root_dir / "valid.txt"
        txt_file.write_text("initial", encoding="utf-8")
        txt_mtime_ns = str(txt_file.stat().st_mtime_ns)

        payload_oversized = json.dumps(
            {
                "path": str(txt_file),
                "content": "A" * (2 * 1024 * 1024 + 10),
                "expected_mtime_ns": txt_mtime_ns,
            }
        ).encode("utf-8")

        status, _, _ = asyncio.run(
            make_request(
                "POST",
                "/api/file-content",
                headers=[
                    ("Cookie", f"litesync_session={self.session_cookie}"),
                    ("Content-Type", "application/json"),
                ],
                body=payload_oversized,
            )
        )
        self.assertEqual(status, 413)


if __name__ == "__main__":
    unittest.main()


if __name__ == "__main__":
    unittest.main()
