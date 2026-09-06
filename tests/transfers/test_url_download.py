import asyncio
import http.server
import ipaddress
import os
import socket
import socketserver
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch, MagicMock

from app.config import Settings, User
from app.transfers import db, scheduler
from app.transfers.engine_url_download import (
    validate_download_url,
    validate_and_resolve_host,
    is_private_or_restricted_ip,
    extract_inferred_filename,
    _sync_url_download_worker,
)
from app.transfers.routes import UrlDownloadRequest, create_url_download
from fastapi import HTTPException


class MockHTTPHandler(http.server.BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass

    def do_GET(self):
        if self.path == "/test.txt":
            content = b"Hello from remote server!"
            self.send_response(200)
            self.send_header("Content-Type", "text/plain")
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/no-content-length.bin":
            content = b"Y" * (1024 * 1024)
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/redirect-to-test":
            self.send_response(302)
            self.send_header("Location", f"http://127.0.0.1:{self.server.server_address[1]}/test.txt")
            self.end_headers()
        elif self.path == "/redirect-to-private":
            self.send_response(302)
            self.send_header("Location", "http://169.254.169.254/latest/meta-data")
            self.end_headers()
        elif self.path == "/oversized.bin":
            content = b"Z" * (6 * 1024 * 1024)
            self.send_response(200)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        elif self.path == "/hang":
            # Don't send response to trigger timeout
            import time
            time.sleep(5)
        elif self.path == "/404":
            self.send_response(404)
            self.end_headers()
        else:
            self.send_response(400)
            self.end_headers()


class TestUrlDownload(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        # Start a local mock server on localhost (for controlled tests)
        cls.server = socketserver.TCPServer(("127.0.0.1", 0), MockHTTPHandler)
        cls.port = cls.server.server_address[1]
        cls.server_thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.server_thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.base_dir = Path(self.temp_dir.name)
        self.data_dir = self.base_dir / "data"
        self.dest_dir = self.base_dir / "dest"

        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.dest_dir.mkdir(parents=True, exist_ok=True)

        db.init_db(self.data_dir)

        self.settings = Settings(
            allowed_roots=[self.dest_dir],
            users=[User(username="test", password_hash="hash")],
            secret_key="secret",
            session_max_age=3600,
            secure_cookie=False,
            data_dir=self.data_dir,
            host="127.0.0.1",
            port=8000,
            max_upload_size_mb=5, # 5MB cap
        )

    def tearDown(self):
        self.temp_dir.cleanup()

    # 1. SSRF check - Private & loopback IP addresses rejected
    def test_ssrf_rejects_private_and_loopback_ips(self):
        forbidden_urls = [
            "http://127.0.0.1/secret",
            "http://127.0.0.2:8080/test",
            "http://localhost/",
            "http://10.0.0.1/admin",
            "http://172.16.0.1/",
            "http://192.168.1.1/router",
            "http://169.254.169.254/latest/meta-data",
            "http://[::1]/",
            "http://[fe80::1]/",
            "http://[fc00::1]/",
        ]
        for url in forbidden_urls:
            with self.subTest(url=url):
                with self.assertRaises((ValueError, HTTPException)):
                    validate_download_url(url)

    # 2. SSRF check - Non-http(s) schemes rejected
    def test_ssrf_rejects_non_http_schemes(self):
        schemes = [
            "file:///etc/passwd",
            "ftp://example.com/file.zip",
            "gopher://example.com/",
            "data:text/plain;base64,SGVsbG8=",
        ]
        for url in schemes:
            with self.subTest(url=url):
                with self.assertRaises(ValueError):
                    validate_download_url(url)

    # 3. SSRF check - DNS Rebinding / Connection-time TOCTOU mitigation
    def test_dns_rebinding_connection_time_rejection(self):
        # Even if upfront validation was bypassed or passed, socket-level connection time re-checks DNS
        target_path = self.dest_dir / "rebind.txt"
        log_path = db.get_task_log_path("rebind_task", self.data_dir)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        with open(log_path, "wb") as log_fh:
            # Mock getaddrinfo inside engine_url_download to return 127.0.0.1
            with patch("socket.getaddrinfo", return_value=[(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 80))]):
                with self.assertRaises(Exception) as ctx:
                    _sync_url_download_worker(
                        task_id="rebind_task",
                        url="http://attacker-controlled-rebinding-domain.com/data",
                        target_path=target_path,
                        log_fh=log_fh,
                    )
                self.assertTrue("private/restricted IP" in str(ctx.exception) or "forbidden" in str(ctx.exception))

    # 4. SSRF check - Redirect to private IP is blocked
    def test_redirect_to_private_ip_is_blocked(self):
        target_path = self.dest_dir / "redirect_blocked.txt"
        log_path = db.get_task_log_path("redir_task", self.data_dir)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        # Allow initial mock connection by bypassing initial IP validation to mock server
        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            with open(log_path, "wb") as log_fh:
                with self.assertRaises(Exception) as ctx:
                    _sync_url_download_worker(
                        task_id="redir_task",
                        url=f"http://127.0.0.1:{self.port}/redirect-to-private",
                        target_path=target_path,
                        log_fh=log_fh,
                    )
                self.assertFalse(target_path.exists())

    # 5. Happy path - Valid download with Content-Length and Activity Log entry
    def test_valid_download_with_content_length_success(self):
        url = f"http://127.0.0.1:{self.port}/test.txt"
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=url,
            destination=str(self.dest_dir / "test.txt"),
            operation="url_download",
            on_conflict="skip",
        )

        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        self.assertEqual(finished["exit_code"], 0)

        target_file = self.dest_dir / "test.txt"
        self.assertTrue(target_file.exists())
        self.assertEqual(target_file.read_bytes(), b"Hello from remote server!")

        # Verify activity log entry
        activities = db.list_activity(limit=10)
        self.assertTrue(len(activities) > 0)
        act = activities[0]
        self.assertEqual(act["kind"], "transfer")
        import json
        msg = json.loads(act["message"])
        self.assertEqual(msg["operation"], "url_download")
        self.assertEqual(msg["status"], "succeeded")
        self.assertIn("test.txt", msg["summary"])

    # 6. Content-Length absent handled gracefully
    def test_download_without_content_length_graceful(self):
        url = f"http://127.0.0.1:{self.port}/no-content-length.bin"
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=url,
            destination=str(self.dest_dir / "no-content-length.bin"),
            operation="url_download",
        )
        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        target_file = self.dest_dir / "no-content-length.bin"
        self.assertTrue(target_file.exists())
        self.assertEqual(target_file.stat().st_size, 1024 * 1024)

    # 7. Max download size cap enforced (Content-Length and streaming)
    def test_max_download_size_cap_enforced(self):
        url = f"http://127.0.0.1:{self.port}/oversized.bin" # 6MB exceeds 5MB limit
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=url,
            destination=str(self.dest_dir / "oversized.bin"),
            operation="url_download",
        )
        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "failed")
        self.assertIn("exceeds maximum download size", finished["error_message"])
        self.assertFalse((self.dest_dir / "oversized.bin").exists())

        # Assert no leftover temp files
        tmp_files = list(self.dest_dir.glob(".litesync-download-*.tmp"))
        self.assertEqual(tmp_files, [])

    # 8. Failed download (404) cleans up temp file and sets status failed
    def test_failed_download_cleans_up_temp_file(self):
        url = f"http://127.0.0.1:{self.port}/404"
        task_id = scheduler.queue_task(
            settings=self.settings,
            source=url,
            destination=str(self.dest_dir / "notfound.txt"),
            operation="url_download",
        )
        db.mark_running(task_id)
        task = db.get_task(task_id)

        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "failed")
        self.assertIn("HTTP 404", finished["error_message"])
        self.assertFalse((self.dest_dir / "notfound.txt").exists())
        tmp_files = list(self.dest_dir.glob(".litesync-download-*.tmp"))
        self.assertEqual(tmp_files, [])

    # 9. Cancellation during download cleans up temp file and marks interrupted
    def test_cancellation_cleans_up_temp_file(self):
        from app.transfers.engine_url_download import cancel_url_download_task, set_url_download_task_id
        task_id = "test_cancel_url"
        set_url_download_task_id(task_id)
        cancel_url_download_task(task_id)

        log_path = db.get_task_log_path(task_id, self.data_dir)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        target_file = self.dest_dir / "cancel_me.txt"

        with open(log_path, "wb") as log_fh:
            with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
                with self.assertRaises(InterruptedError):
                    _sync_url_download_worker(
                        task_id=task_id,
                        url=f"http://127.0.0.1:{self.port}/test.txt",
                        target_path=target_file,
                        log_fh=log_fh,
                    )

        self.assertFalse(target_file.exists())
        tmp_files = list(self.dest_dir.glob(".litesync-download-*.tmp"))
        self.assertEqual(tmp_files, [])

    # 10. Conflict resolution (rename, overwrite, skip)
    def test_conflict_resolution_modes(self):
        # Pre-create target
        target_file = self.dest_dir / "existing.txt"
        target_file.write_text("pre-existing content")

        # 1. Skip mode -> should fail/skip
        task_id_skip = scheduler.queue_task(
            settings=self.settings,
            source=f"http://127.0.0.1:{self.port}/test.txt",
            destination=str(self.dest_dir / "existing.txt"),
            operation="url_download",
            on_conflict="skip",
        )
        db.mark_running(task_id_skip)
        task_skip = db.get_task(task_id_skip)
        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task_skip, self.settings))
        self.assertEqual(db.get_task(task_id_skip)["status"], "failed")
        self.assertEqual(target_file.read_text(), "pre-existing content")

        # 2. Rename mode -> should write to existing_1.txt
        task_id_rename = scheduler.queue_task(
            settings=self.settings,
            source=f"http://127.0.0.1:{self.port}/test.txt",
            destination=str(self.dest_dir / "existing.txt"),
            operation="url_download",
            on_conflict="rename",
        )
        db.mark_running(task_id_rename)
        task_rename = db.get_task(task_id_rename)
        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task_rename, self.settings))
        self.assertEqual(db.get_task(task_id_rename)["status"], "succeeded")
        self.assertTrue((self.dest_dir / "existing_1.txt").exists())

        # 3. Overwrite mode -> should overwrite existing.txt
        task_id_overwrite = scheduler.queue_task(
            settings=self.settings,
            source=f"http://127.0.0.1:{self.port}/test.txt",
            destination=str(self.dest_dir / "existing.txt"),
            operation="url_download",
            on_conflict="overwrite",
        )
        db.mark_running(task_id_overwrite)
        task_overwrite = db.get_task(task_id_overwrite)
        with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
            asyncio.run(scheduler._run_task(task_overwrite, self.settings))
        self.assertEqual(db.get_task(task_id_overwrite)["status"], "succeeded")
        self.assertEqual(target_file.read_bytes(), b"Hello from remote server!")

    # 11. Timeout enforced on hung response
    def test_timeout_enforced(self):
        target_path = self.dest_dir / "timeout.txt"
        log_path = db.get_task_log_path("timeout_task", self.data_dir)
        log_path.parent.mkdir(parents=True, exist_ok=True)

        with open(log_path, "wb") as log_fh:
            with patch("app.transfers.engine_url_download.validate_and_resolve_host", return_value=["127.0.0.1"]):
                with self.assertRaises(Exception) as ctx:
                    _sync_url_download_worker(
                        task_id="timeout_task",
                        url=f"http://127.0.0.1:{self.port}/hang",
                        target_path=target_path,
                        log_fh=log_fh,
                        timeout=0.5, # 500ms timeout
                    )
                self.assertFalse(target_path.exists())

    # 12. API Endpoint POST /api/transfer/url
    def test_api_create_url_download(self):
        req = UrlDownloadRequest(
            url="https://example.com/archive.tar.gz",
            destination=str(self.dest_dir),
            filename="my_archive.tar.gz",
            on_conflict="rename",
        )
        with patch("app.transfers.routes.get_settings", return_value=self.settings), \
             patch("app.transfers.routes.validate_download_url"):
            res = asyncio.run(create_url_download(req, user="test"))
            self.assertIn("task_id", res)
            self.assertEqual(res["filename"], "my_archive.tar.gz")

            task = db.get_task(res["task_id"])
            self.assertIsNotNone(task)
            self.assertEqual(task["operation"], "url_download")
            self.assertEqual(task["status"], "queued")
            self.assertEqual(task["on_conflict"], "rename")

    # 13. Real HTTPS download end-to-end to verify SafeHTTPSConnection SSL context fix
    def test_real_https_download_e2e(self):
        import pytest
        import socket
        
        # Ensure network access is available to prevent confusing failures in offline environments
        try:
            socket.create_connection(("example.com", 443), timeout=3).close()
        except OSError:
            pytest.skip("Network access to example.com is unavailable")

        # We perform a real download from example.com to verify our custom connection wrapper
        # actually correctly configures SSL and passes the SNI validation without raising AttributeError.
        target_file = self.dest_dir / "example.html"
        task_id = scheduler.queue_task(
            settings=self.settings,
            source="https://example.com/",
            destination=str(target_file),
            operation="url_download",
        )
        db.mark_running(task_id)
        task = db.get_task(task_id)

        # Do NOT patch validate_and_resolve_host; we want the real socket and SSL wrapping!
        asyncio.run(scheduler._run_task(task, self.settings))

        finished = db.get_task(task_id)
        self.assertEqual(finished["status"], "succeeded")
        self.assertTrue(target_file.exists())
        self.assertTrue(len(target_file.read_bytes()) > 0)


if __name__ == "__main__":
    unittest.main()
