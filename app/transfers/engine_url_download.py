from __future__ import annotations

import http.client
import ipaddress
import os
import secrets
import socket
import ssl
import urllib.parse
import urllib.request
from pathlib import Path

_current_url_download_task_id: str | None = None
_url_download_cancel_flag: bool = False


def set_url_download_task_id(task_id: str | None) -> None:
    global _current_url_download_task_id, _url_download_cancel_flag
    _current_url_download_task_id = task_id
    _url_download_cancel_flag = False


def cancel_url_download_task(task_id: str) -> bool:
    global _current_url_download_task_id, _url_download_cancel_flag
    if _current_url_download_task_id == task_id:
        _url_download_cancel_flag = True
        return True
    return False


def is_private_or_restricted_ip(ip_str: str) -> bool:
    """Check if an IP string is private, loopback, link-local, reserved, multicast, or unspecified."""
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return True

    if (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
        or ip.is_unspecified
    ):
        return True

    if isinstance(ip, ipaddress.IPv6Address):
        if ip.ipv4_mapped and is_private_or_restricted_ip(str(ip.ipv4_mapped)):
            return True
        if ip.sixtofour and is_private_or_restricted_ip(str(ip.sixtofour)):
            return True

    return False


def validate_and_resolve_host(hostname: str, port: int) -> list[str]:
    """Resolve hostname to IP addresses and ensure none are private or restricted.
    Returns list of validated public IP strings."""
    if not hostname:
        raise ValueError("Hostname cannot be empty")

    try:
        ip_obj = ipaddress.ip_address(hostname.strip("[]"))
        if is_private_or_restricted_ip(str(ip_obj)):
            raise ValueError(f"Access to private/restricted IP address is forbidden: {hostname}")
        return [str(ip_obj)]
    except ValueError as e:
        if "Access to private" in str(e):
            raise

    try:
        addr_info = socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM)
    except socket.gaierror as e:
        raise ValueError(f"Could not resolve hostname '{hostname}': {e}") from e

    if not addr_info:
        raise ValueError(f"No address records found for hostname '{hostname}'")

    resolved_ips: list[str] = []
    for entry in addr_info:
        ip = entry[4][0]
        if is_private_or_restricted_ip(ip):
            raise ValueError(f"Hostname '{hostname}' resolved to private/restricted IP: {ip}")
        resolved_ips.append(ip)

    return resolved_ips


def validate_download_url(url: str) -> None:
    """Validate URL scheme and ensure resolved host is public (SSRF check)."""
    if not url or not isinstance(url, str):
        raise ValueError("URL is required")

    parsed = urllib.parse.urlsplit(url.strip())
    if parsed.scheme.lower() not in ("http", "https"):
        raise ValueError(f"Invalid URL scheme '{parsed.scheme}'. Only http:// and https:// are allowed.")

    if not parsed.hostname:
        raise ValueError("URL must contain a valid hostname")

    port = parsed.port or (443 if parsed.scheme.lower() == "https" else 80)
    validate_and_resolve_host(parsed.hostname, port)


class SafeHTTPConnection(http.client.HTTPConnection):
    """HTTPConnection that validates IPs at connection time and connects directly to validated IP."""

    def connect(self):
        port = self.port or 80
        validated_ips = validate_and_resolve_host(self.host, port)
        target_ip = validated_ips[0]

        self.sock = socket.create_connection(
            (target_ip, port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self._tunnel()


class SafeHTTPSConnection(http.client.HTTPSConnection):
    """HTTPSConnection that validates IPs at connection time, connects to validated IP,
    and performs SNI & TLS validation using the original hostname."""

    def connect(self):
        port = self.port or 443
        validated_ips = validate_and_resolve_host(self.host, port)
        target_ip = validated_ips[0]

        sock = socket.create_connection(
            (target_ip, port),
            self.timeout,
            self.source_address,
        )
        if self._tunnel_host:
            self.sock = sock
            self._tunnel()
            sock = self.sock

        server_hostname = self._tunnel_host or self.host
        if self.context is None:
            self.context = ssl.create_default_context()
        self.sock = self.context.wrap_socket(sock, server_hostname=server_hostname)


class SafeHTTPHandler(urllib.request.HTTPHandler):
    def http_open(self, req):
        return self.do_open(SafeHTTPConnection, req)


class SafeHTTPSHandler(urllib.request.HTTPSHandler):
    def https_open(self, req):
        return self.do_open(SafeHTTPSConnection, req, context=self._context)


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that validates each redirect target against the SSRF guard."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        try:
            validate_download_url(newurl)
        except Exception as e:
            raise urllib.error.HTTPError(
                newurl, code, f"SSRF validation failed on redirect: {e}", headers, fp
            ) from e

        return super().redirect_request(req, fp, code, msg, headers, newurl)


def build_safe_opener():
    """Build a urllib opener equipped with connection-time SSRF validation and safe redirect handling."""
    return urllib.request.build_opener(
        SafeHTTPHandler(),
        SafeHTTPSHandler(),
        SafeRedirectHandler(),
    )


def extract_inferred_filename(url: str, content_disposition: str | None = None) -> str:
    """Infer a clean filename from Content-Disposition header or the URL path."""
    if content_disposition:
        parts = content_disposition.split(";")
        for part in parts:
            part = part.strip()
            if part.lower().startswith("filename*="):
                val = part[len("filename*=") :].strip()
                if "''" in val:
                    val = val.split("''", 1)[1]
                val = urllib.parse.unquote(val.strip("\"'"))
                if val:
                    return os.path.basename(val)
            elif part.lower().startswith("filename="):
                val = part[len("filename=") :].strip().strip("\"'")
                if val:
                    return os.path.basename(val)

    parsed = urllib.parse.urlsplit(url)
    path = parsed.path.strip("/")
    if path:
        base = os.path.basename(path)
        base = urllib.parse.unquote(base)
        if base:
            return base

    hostname = parsed.hostname or "download"
    return f"{hostname}.download"


def _sync_url_download_worker(
    task_id: str,
    url: str,
    target_path: Path,
    log_fh,
    max_size_bytes: int = 5 * 1024 * 1024 * 1024,
    timeout: float = 30.0,
) -> None:
    """Synchronous worker to perform streaming download from URL to destination with progress updates."""
    global _url_download_cancel_flag
    dest_dir = target_path.parent
    dest_dir.mkdir(parents=True, exist_ok=True)

    temp_filename = f".litesync-download-{secrets.token_hex(8)}.tmp"
    temp_path = dest_dir / temp_filename
    bytes_written = 0

    req = urllib.request.Request(
        url,
        headers={"User-Agent": "LiteSync/1.0 (Downloader)"},
    )
    opener = build_safe_opener()

    try:
        try:
            resp = opener.open(req, timeout=timeout)
        except urllib.error.HTTPError as e:
            raise RuntimeError(f"Remote server returned HTTP {e.code}: {e.reason}") from e
        except urllib.error.URLError as e:
            raise RuntimeError(f"Failed to connect to remote server: {e.reason}") from e

        with resp:
            content_length_str = resp.headers.get("Content-Length")
            total_size = int(content_length_str) if content_length_str and content_length_str.isdigit() else None

            if total_size is not None and total_size > max_size_bytes:
                max_mb = max_size_bytes // (1024 * 1024)
                raise RuntimeError(f"File size exceeds maximum download size of {max_mb} MB")

            chunk_size = 64 * 1024
            last_pct = -1
            last_logged_bytes = 0

            with open(temp_path, "wb") as out_f:
                while True:
                    if _url_download_cancel_flag:
                        raise InterruptedError("Download cancelled by user")

                    chunk = resp.read(chunk_size)
                    if not chunk:
                        break

                    bytes_written += len(chunk)
                    if bytes_written > max_size_bytes:
                        max_mb = max_size_bytes // (1024 * 1024)
                        raise RuntimeError(f"File size exceeds maximum download size of {max_mb} MB")

                    out_f.write(chunk)

                    if total_size is not None and total_size > 0:
                        pct = int((bytes_written / total_size) * 100)
                        if pct != last_pct:
                            last_pct = pct
                            try:
                                log_fh.write(f" {pct}%\n".encode("utf-8"))
                                log_fh.flush()
                            except OSError:
                                pass
                    else:
                        if bytes_written - last_logged_bytes >= 512 * 1024:
                            last_logged_bytes = bytes_written
                            mb_str = f"{bytes_written / (1024 * 1024):.2f} MB"
                            try:
                                log_fh.write(f"Downloaded {mb_str}\n".encode("utf-8"))
                                log_fh.flush()
                            except OSError:
                                pass

            os.rename(temp_path, target_path)

            try:
                log_fh.write(f"{target_path.name}\n".encode("utf-8"))
                log_fh.write(b"            100%    0.00kB/s    0:00:00 (xfr, to-chk=0/1)\n")
                log_fh.flush()
            except OSError:
                pass

    except Exception:
        temp_path.unlink(missing_ok=True)
        raise
