<div align="center">

  <!-- Badges -->
  <p>
    <a href="https://www.python.org/"><img src="https://img.shields.io/badge/python-3.11+-3776AB.svg?style=flat-square&logo=python&logoColor=white" alt="Python Version"></a>
    <a href="https://fastapi.tiangolo.com/"><img src="https://img.shields.io/badge/FastAPI-005571?style=flat-square&logo=fastapi" alt="FastAPI"></a>
    <a href="#"><img src="https://img.shields.io/badge/platform-Raspberry%20Pi%20%7C%20Linux-C51A4A.svg?style=flat-square&logo=raspberry-pi&logoColor=white" alt="Platform"></a>
    <a href="#"><img src="https://img.shields.io/badge/engine-rsync%20%2B%20kernel%20copy-blue.svg?style=flat-square" alt="Engine"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg?style=flat-square" alt="License"></a>
  </p>

  <br />

  <!-- Logo -->
  <img src="docs/logo.svg" width="96" height="96" alt="LiteSync Logo" />

  <!-- Title & Subtitle -->
  <h1>LiteSync</h1>
  <p><b>Ultra-lightweight single/dual-pane file transfer web app for Raspberry Pi.</b></p>
  <p><i>Browse directories, manage transfers with a dual-engine backend (<code>rsync</code> or zero-copy <code>os.copy_file_range</code>), and stream uploads straight to disk.</i></p>

  <br />

  <!-- Primary Hero Screenshot -->
  <a href="docs/screenshots/hero-dual-pane.jpg">
    <img src="docs/screenshots/hero-dual-pane.jpg" alt="LiteSync Interface" width="100%" />
  </a>

</div>

---

## Features

<div align="center">
  <a href="docs/screenshots/transfer-modal.jpg">
    <img src="docs/screenshots/transfer-modal.jpg" alt="Transfer Modal with Exclusions" width="80%" />
  </a>
</div>

* **Dual-Pane & Single-Pane Views:** Side-by-side local browsing or simplified single-pane view for mobile devices.
* **Dual Transfer Engine:** Seamlessly toggle between zero-copy Linux Kernel transfers (`os.copy_file_range`) and resumable `rsync` processes.
* **Persistent Background Work:** Transfers execute as isolated background processes and survive browser disconnects.
* **Direct-to-Disk Streamed Uploads:** High-speed multipart uploads routed directly to disk to prevent RAM exhaustion on host hardware.
* **Contextual Exclusion Rules:** Exclude subfolders visually with automatic `rsync` fallback enforcement.

---

## Requirements

- Python 3.11+
- `rsync` installed on the host
- `python3-venv`

---

## Setup (development or Pi)

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp config.example.toml config.toml
# Edit config.toml: set allowed_roots, secret_key, and at least one user.

python -c "import secrets; print(secrets.token_hex(32))"   # -> secret_key
python -m app.auth hash "yourpassword"                      # -> password_hash

chmod 600 config.toml

uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1