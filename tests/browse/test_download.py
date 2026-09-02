from __future__ import annotations

import asyncio
import os
import tempfile
import time
import unittest
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from app.auth import create_session_cookie
from app.config import Settings, User, get_download_signing_key, load_settings
from app.main import app
from app.browse.download import compute_download_signature, verify_download_signature


async def make_request(
    method: str,
    path: str,
    query_string: str = "",
    headers: list[tuple[str, str]] | None = None,
    body: bytes = b"",
) -> tuple[int, dict[str, str], bytes]:
    """Execute an ASGI request directly against the FastAPI app."""
    if headers is None:
        headers = []
    raw_headers = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers]
    scope = {
        "type": "http",
        "http_version": "1.1",
        "method": method.upper(),
        "path": path,
        "raw_path": path.encode("ascii"),
        "query_string": query_string.encode("ascii"),
        "headers": raw_headers,
        "extensions": {},
    }
    messages = []

    async def send(msg):
        messages.append(msg)

    async def receive():
        return {"type": "http.request", "body": body, "more_body": False}

    await app(scope, receive, send)

    status_code = 500
    response_headers = {}
    response_body = b""

    for msg in messages:
        if msg["type"] == "http.response.start":
            status_code = msg["status"]
            response_headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in msg.get("headers", [])}
        elif msg["type"] == "http.response.body":
            response_body += msg.get("body", b"")

    return status_code, response_headers, response_body


class TestDownloadAndVlcEndpoint(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root_dir = Path(self.temp_dir.name) / "allowed_root"
        self.root_dir.mkdir(parents=True, exist_ok=True)
        self.outside_dir = Path(self.temp_dir.name) / "outside"
        self.outside_dir.mkdir(parents=True, exist_ok=True)

        self.config_file = Path(self.temp_dir.name) / "config.toml"
        config_content = f"""
allowed_roots = ["{self.root_dir}"]
secret_key = "test_master_secret_key_for_litesync"
session_max_age = 3600
download_expiry = 7200
data_dir = "{self.temp_dir.name}/data"
host = "127.0.0.1"
port = 8000

[[users]]
username = "pi"
password_hash = "$2b$12$e8uq..."
"""
        self.config_file.write_text(config_content)
        self.old_env = os.environ.get("LITESYNC_CONFIG")
        os.environ["LITESYNC_CONFIG"] = str(self.config_file)

        # Force reload settings
        import app.config
        app.config._settings = None
        self.settings = load_settings(self.config_file)
        app.config._settings = self.settings

        # Create standard test file
        self.test_content = b"0123456789" * 100  # 1000 bytes
        self.test_file = self.root_dir / "sample_video.mp4"
        self.test_file.write_bytes(self.test_content)

        # Create valid session cookie
        self.session_cookie = create_session_cookie("pi")

    def tearDown(self):
        if self.old_env is not None:
            os.environ["LITESYNC_CONFIG"] = self.old_env
        else:
            os.environ.pop("LITESYNC_CONFIG", None)
        import app.config
        app.config._settings = None
        self.temp_dir.cleanup()

    def _generate_signed_params(self, file_path: Path, expiry_offset: int = 3600) -> tuple[int, str]:
        expires = int(time.time()) + expiry_offset
        signing_key = get_download_signing_key(self.settings)
        sig = compute_download_signature(file_path.resolve(), expires, signing_key)
        return expires, sig

    def test_normal_get_returns_file(self):
        """Test normal authenticated GET returns 200 with full content and headers."""
        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(self.test_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, self.test_content)
        self.assertEqual(headers.get("content-length"), "1000")
        self.assertEqual(headers.get("accept-ranges"), "bytes")
        self.assertIn("filename=", headers.get("content-disposition", ""))

    def test_filename_preserved_unicode_and_special_chars(self):
        """Test filename preservation with Unicode, emojis, spaces, and punctuation."""
        unicode_name = "🎬 My Movie (2026) & 特殊 characters.mkv"
        unicode_file = self.root_dir / unicode_name
        unicode_file.write_bytes(b"media stream data")

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(unicode_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b"media stream data")
        disp = headers.get("content-disposition", "")
        self.assertIn("filename*=utf-8''", disp)
        self.assertIn("%F0%9F%8E%AC", disp)  # URL-encoded emoji 🎬

    def test_authenticated_browser_request_works(self):
        """Test authenticated session cookie works without query signature."""
        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(self.test_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(len(body), 1000)

    def test_valid_signed_url_works_without_browser_cookie(self):
        """Test valid signed URL allows unauthenticated client (e.g. VLC) to download."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        status, headers, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs)
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, self.test_content)
        self.assertEqual(headers.get("accept-ranges"), "bytes")

    def test_expired_signed_url_fails(self):
        """Test signed URL with expired timestamp fails with HTTP 403."""
        expires, sig = self._generate_signed_params(self.test_file, expiry_offset=-10)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        status, _, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs)
        )
        self.assertEqual(status, 403)
        self.assertIn(b"expired", body.lower())

    def test_invalid_signature_fails(self):
        """Test tampered signature fails with HTTP 403."""
        expires, _ = self._generate_signed_params(self.test_file)
        bad_sig = "a" * 64
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={bad_sig}"

        status, _, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs)
        )
        self.assertEqual(status, 403)
        self.assertIn(b"invalid download signature", body.lower())

    def test_path_outside_allowed_root_fails(self):
        """Test access to files outside allowed roots is forbidden with HTTP 403."""
        outside_file = self.outside_dir / "secret.txt"
        outside_file.write_text("secret outside")

        # Authenticated attempt
        status, _, _ = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(outside_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 403)

        # Signed URL attempt
        expires, sig = self._generate_signed_params(outside_file)
        qs = f"path={quote(str(outside_file))}&expires={expires}&signature={sig}"
        status, _, _ = asyncio.run(make_request("GET", "/api/download", query_string=qs))
        self.assertEqual(status, 403)

    def test_traversal_fails(self):
        """Test path traversal (../ and encoded variants) is rejected."""
        traversal_path = str(self.root_dir) + "/../outside/secret.txt"
        status, _, _ = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(traversal_path)}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 403)

    def test_symlink_escape_fails(self):
        """Test symlink pointing outside the allowed root is rejected."""
        outside_target = self.outside_dir / "target.txt"
        outside_target.write_text("outside target data")

        symlink_file = self.root_dir / "escape_link.txt"
        symlink_file.symlink_to(outside_target)

        status, _, _ = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(symlink_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 403)

    def test_range_request_partial_response(self):
        """Test single Range requests return 206 Partial Content with correct Content-Range and data."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        # 1. Range bytes=0-9 (first 10 bytes)
        status, headers, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs, headers=[("Range", "bytes=0-9")])
        )
        self.assertEqual(status, 206)
        self.assertEqual(headers.get("content-range"), "bytes 0-9/1000")
        self.assertEqual(headers.get("content-length"), "10")
        self.assertEqual(body, self.test_content[0:10])

        # 2. Range bytes=500-599 (middle 100 bytes)
        status, headers, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs, headers=[("Range", "bytes=500-599")])
        )
        self.assertEqual(status, 206)
        self.assertEqual(headers.get("content-range"), "bytes 500-599/1000")
        self.assertEqual(headers.get("content-length"), "100")
        self.assertEqual(body, self.test_content[500:600])

        # 3. Range bytes=900- (last 100 bytes)
        status, headers, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs, headers=[("Range", "bytes=900-")])
        )
        self.assertEqual(status, 206)
        self.assertEqual(headers.get("content-range"), "bytes 900-999/1000")
        self.assertEqual(headers.get("content-length"), "100")
        self.assertEqual(body, self.test_content[900:])

    def test_range_out_of_bounds_returns_416(self):
        """Test out of bounds range request returns 416 Range Not Satisfiable."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        status, headers, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs, headers=[("Range", "bytes=2000-3000")])
        )
        self.assertEqual(status, 416)
        self.assertEqual(headers.get("content-range"), "bytes */1000")

    def test_multi_range_request_returns_416(self):
        """Test multi-range request is rejected with 416 Range Not Satisfiable per design."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=qs,
                headers=[("Range", "bytes=0-49, 100-149")],
            )
        )
        self.assertEqual(status, 416)
        self.assertEqual(headers.get("content-range"), "bytes */1000")
        self.assertEqual(headers.get("content-length"), "0")
        self.assertEqual(body, b"")

    def test_vlc_style_http_access_head_and_range(self):
        """Test VLC/mpv workflow: initial HEAD request followed by Range GET requests."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        # Step 1: HEAD probe
        head_status, head_headers, head_body = asyncio.run(
            make_request("HEAD", "/api/download", query_string=qs)
        )
        self.assertEqual(head_status, 200)
        self.assertEqual(head_headers.get("accept-ranges"), "bytes")
        self.assertEqual(head_headers.get("content-length"), "1000")
        self.assertEqual(head_body, b"")

        # Step 2: VLC seeks into stream with Range request
        get_status, get_headers, get_body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs, headers=[("Range", "bytes=0-1023")])
        )
        self.assertEqual(get_status, 206)
        self.assertEqual(get_headers.get("content-range"), "bytes 0-999/1000")
        self.assertEqual(get_body, self.test_content)

    def test_filename_cannot_be_influenced_by_client(self):
        """Test client-supplied filename query parameters cannot alter server Content-Disposition."""
        fake_name = "malicious_script.sh"
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}&filename={fake_name}"

        status, headers, _ = asyncio.run(
            make_request("GET", "/api/download", query_string=qs)
        )
        self.assertEqual(status, 200)
        disp = headers.get("content-disposition", "")
        self.assertIn('filename="sample_video.mp4"', disp)
        self.assertNotIn(fake_name, disp)

    def test_secret_persists_across_simulated_restart(self):
        """Test signed URL generated before restart remains valid after settings reload."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}"

        # Simulate restart by resetting _settings cache and reloading from config.toml
        import app.config
        app.config._settings = None
        new_settings = load_settings(self.config_file)
        app.config._settings = new_settings

        # Validate with the new reloaded settings
        status, _, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs)
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, self.test_content)

    def test_server_side_link_generation_endpoint(self):
        """Test GET /api/download/link generates valid verifiable URLs for authenticated users."""
        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/download/link",
                query_string=f"path={quote(str(self.test_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        import json
        data = json.loads(body.decode("utf-8"))
        self.assertIn("url", data)
        self.assertIn("expires", data)
        self.assertIn("signature", data["url"])

        # Directly invoke the returned URL to verify it downloads successfully
        parsed = urlparse(data["url"])
        dl_status, _, dl_body = asyncio.run(
            make_request("GET", parsed.path, query_string=parsed.query)
        )
        self.assertEqual(dl_status, 200)
        self.assertEqual(dl_body, self.test_content)

    def test_unauthenticated_request_returns_clean_401(self):
        """Test unauthenticated request returns clean 401 without WWW-Authenticate header."""
        status, headers, _ = asyncio.run(
            make_request("GET", "/api/download", query_string=f"path={quote(str(self.test_file))}")
        )
        self.assertEqual(status, 401)
        self.assertNotIn("www-authenticate", headers)

    def test_domain_separation_key_derivation(self):
        """Test that signatures computed with raw secret_key are rejected due to domain separation."""
        expires = int(time.time()) + 3600
        # Compute signature with raw secret_key instead of domain-separated key
        raw_sig = compute_download_signature(self.test_file.resolve(), expires, self.settings.secret_key)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={raw_sig}"

        status, _, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs)
        )
        self.assertEqual(status, 403)
        self.assertIn(b"invalid download signature", body.lower())

    def test_inline_pdf(self):
        """Test opening a PDF with disposition=inline serves inline Content-Disposition and application/pdf."""
        pdf_file = self.root_dir / "document.pdf"
        pdf_file.write_bytes(b"%PDF-1.5 sample pdf content")

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(pdf_file))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b"%PDF-1.5 sample pdf content")
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("application/pdf", headers.get("content-type", ""))
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    def test_inline_images(self):
        """Test opening images (jpg, png, gif, webp) with disposition=inline serves inline and correct Content-Type."""
        for name, mime in [
            ("test.jpg", "image/jpeg"),
            ("test.png", "image/png"),
            ("test.gif", "image/gif"),
            ("test.webp", "image/webp"),
        ]:
            img_file = self.root_dir / name
            img_file.write_bytes(b"fake_image_bytes")
            status, headers, _ = asyncio.run(
                make_request(
                    "GET",
                    "/api/download",
                    query_string=f"path={quote(str(img_file))}&disposition=inline",
                    headers=[("Cookie", f"litesync_session={self.session_cookie}")],
                )
            )
            self.assertEqual(status, 200)
            self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
            self.assertIn(mime, headers.get("content-type", ""))
            self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    def test_inline_video_range(self):
        """Test opening a video file with disposition=inline supports Range requests and serves inline."""
        expires, sig = self._generate_signed_params(self.test_file)
        qs = f"path={quote(str(self.test_file))}&expires={expires}&signature={sig}&disposition=inline"

        status, headers, body = asyncio.run(
            make_request("GET", "/api/download", query_string=qs, headers=[("Range", "bytes=0-99")])
        )
        self.assertEqual(status, 206)
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("video/mp4", headers.get("content-type", ""))
        self.assertEqual(headers.get("content-range"), "bytes 0-99/1000")
        self.assertEqual(headers.get("content-length"), "100")
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(body, self.test_content[0:100])

    def test_inline_text(self):
        """Test opening a .txt file with disposition=inline serves inline text/plain."""
        txt_file = self.root_dir / "notes.txt"
        txt_file.write_text("Hello LiteSync text")

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(txt_file))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertEqual(body, b"Hello LiteSync text")
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("text/plain", headers.get("content-type", ""))
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    def test_inline_html_safe_text_fallback(self):
        """Test opening an .html file with disposition=inline forces Content-Type to text/plain and never text/html."""
        html_file = self.root_dir / "page.html"
        html_file.write_text("<html><script>alert('xss')</script><body>Hello</body></html>")

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(html_file))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("text/plain", headers.get("content-type", ""))
        self.assertNotIn("text/html", headers.get("content-type", ""))
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(body, b"<html><script>alert('xss')</script><body>Hello</body></html>")

    def test_inline_svg_safe_text_fallback(self):
        """Test opening an .svg file with disposition=inline forces Content-Type to text/plain and never image/svg+xml."""
        svg_file = self.root_dir / "vector.svg"
        svg_file.write_text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(svg_file))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("text/plain", headers.get("content-type", ""))
        self.assertNotIn("image/svg+xml", headers.get("content-type", ""))
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    def test_direct_api_disposition_inline_enforces_safety(self):
        """Test direct API call with ?disposition=inline on .html file cannot bypass server-side safe fallback."""
        html_file = self.root_dir / "secret.html"
        html_file.write_text("<h1>Secret</h1>")

        expires, sig = self._generate_signed_params(html_file)
        qs = f"path={quote(str(html_file))}&expires={expires}&signature={sig}&disposition=inline"

        status, headers, _ = asyncio.run(make_request("GET", "/api/download", query_string=qs))
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("text/plain", headers.get("content-type", ""))
        self.assertNotIn("text/html", headers.get("content-type", ""))
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")

    def test_mismatched_content_spoofed_safe_extension(self):
        """Test mismatched content (e.g. fake.jpg containing script) served with nosniff and image/jpeg."""
        fake_jpg = self.root_dir / "fake.jpg"
        fake_jpg.write_text("<script>alert('xss')</script>")

        status, headers, body = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(fake_jpg))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-disposition", "").startswith("inline;"))
        self.assertIn("image/jpeg", headers.get("content-type", ""))
        self.assertEqual(headers.get("x-content-type-options"), "nosniff")
        self.assertEqual(body, b"<script>alert('xss')</script>")

    def test_unallowlisted_extension_forces_attachment(self):
        """Test unallowlisted file types (e.g. .sh, .exe, .bin) are forced to attachment even if inline is requested."""
        sh_file = self.root_dir / "script.sh"
        sh_file.write_text("#!/bin/bash\necho hello")

        status, headers, _ = asyncio.run(
            make_request(
                "GET",
                "/api/download",
                query_string=f"path={quote(str(sh_file))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        self.assertTrue(headers.get("content-disposition", "").startswith("attachment;"))

    def test_copy_download_link_produces_attachment_link(self):
        """Test GET /api/download/link without disposition parameter produces attachment link."""
        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/download/link",
                query_string=f"path={quote(str(self.test_file))}",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        import json
        data = json.loads(body.decode("utf-8"))
        self.assertNotIn("disposition=inline", data["url"])

        # Fetching that URL produces Content-Disposition: attachment
        parsed = urlparse(data["url"])
        dl_status, dl_headers, _ = asyncio.run(
            make_request("GET", parsed.path, query_string=parsed.query)
        )
        self.assertEqual(dl_status, 200)
        self.assertTrue(dl_headers.get("content-disposition", "").startswith("attachment;"))

    def test_open_download_link_produces_inline_link(self):
        """Test GET /api/download/link with disposition=inline produces inline link."""
        status, _, body = asyncio.run(
            make_request(
                "GET",
                "/api/download/link",
                query_string=f"path={quote(str(self.test_file))}&disposition=inline",
                headers=[("Cookie", f"litesync_session={self.session_cookie}")],
            )
        )
        self.assertEqual(status, 200)
        import json
        data = json.loads(body.decode("utf-8"))
        self.assertIn("disposition=inline", data["url"])

        # Fetching that URL produces Content-Disposition: inline
        parsed = urlparse(data["url"])
        dl_status, dl_headers, _ = asyncio.run(
            make_request("GET", parsed.path, query_string=parsed.query)
        )
        self.assertEqual(dl_status, 200)
        self.assertTrue(dl_headers.get("content-disposition", "").startswith("inline;"))


if __name__ == "__main__":
    unittest.main()
