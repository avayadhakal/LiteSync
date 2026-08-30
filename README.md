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

* **Dual-Pane & Single-Pane Views:** Side-by-side local browsing or a simplified single-pane view for mobile devices.
* **Dual Transfer Engine:** Seamlessly toggle between zero-copy Linux kernel transfers (`os.copy_file_range`) and resumable `rsync` processes.
* **Pause & Resume:** Instantly pause active `rsync` transfers and resume them later without losing progress, seamlessly picking up exactly where they left off.
* **Persistent Background Work:** Transfers execute as isolated background processes and survive browser disconnects.
* **Direct-to-Disk Streamed Uploads:** Browser uploads are streamed to disk to prevent large files from exhausting system RAM.
* **Smart Conflict Resolution:** Pre-flight modal resolution explicitly handles name collisions with `Skip`, `Keep Both` (sequential append like `_1`, `_2`), or `Replace`.
* **Contextual Exclusion Rules:** Exclude subfolders visually, with automatic `rsync` fallback enforcement.
* **Same-Filesystem Moves:** Moves on the same filesystem use atomic `os.rename()` instead of invoking either transfer engine.
* **Real-Time Progress:** Transfers and uploads expose progress information through the web interface.
* **Persistent Task History:** Transfer task state and activity information are stored in SQLite so task history survives application restarts.
* **Hardened Raspberry Pi Service:** The included installer creates a dedicated system user and configures LiteSync to run as a managed `systemd` service.

---

## Requirements

* Python 3.11+
* `rsync` installed on the host
* `python3-venv`
* Linux filesystem with support for `os.copy_file_range` for the Kernel transfer engine

LiteSync is designed primarily for Raspberry Pi and Linux systems.

---

## Quick Start

For development or manual installation:

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp config.example.toml config.toml
```

Edit `config.toml` and configure:

* `allowed_roots`
* `secret_key`
* at least one user
* any optional upload or application settings you want to customize

Generate a secure secret key:

```sh
python -c "import secrets; print(secrets.token_hex(32))"
```

Generate a password hash:

```sh
python -m app.auth hash "yourpassword"
```

Add the generated values to `config.toml`, then protect the configuration file:

```sh
chmod 600 config.toml
```

Start LiteSync:

```sh
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Open:

```text
http://<host>:8000/
```

> **Important:** LiteSync should be run with a single Uvicorn worker. Transfer state, task execution, and SSE connections are designed around a single application process.

---

## Raspberry Pi Installation

The recommended Raspberry Pi installation uses the release archive and does **not** require Git, `git pull`, or a Git checkout.

Download the LiteSync release archive:

```sh
cd /tmp

curl -L https://gitea.avayahome.xyz/avaya/LiteSync/archive/v0.1.0-alpha.tar.gz \
  -o litesync-v0.1.0-alpha.tar.gz

tar -xzf litesync-v0.1.0-alpha.tar.gz
cd LiteSync-v0.1.0-alpha

sudo bash install.sh
```

The installer will:

1. Stage LiteSync under `/opt/litesync`.
2. Create the dedicated `litesync` system user.
3. Create and manage the Python virtual environment.
4. Install the required Python dependencies.
5. Configure the LiteSync `systemd` service.
6. Apply the service's security restrictions.
7. Start LiteSync automatically.

After installation, LiteSync is managed by `systemd`.

Check the service:

```sh
sudo systemctl status litesync
```

View live service logs:

```sh
sudo journalctl -u litesync -f
```

Restart LiteSync:

```sh
sudo systemctl restart litesync
```

Stop LiteSync:

```sh
sudo systemctl stop litesync
```

Start LiteSync:

```sh
sudo systemctl start litesync
```

Enable LiteSync to start automatically at boot:

```sh
sudo systemctl enable litesync
```

Then visit:

```text
http://<raspberry-pi-ip>:8000/
```

### Updating LiteSync

For a future release, download the new release archive and run its installer rather than using `git pull`.

The installer is designed to be idempotent. Re-running it updates the application and dependencies while preserving existing LiteSync data and configuration.

**Existing files that must be preserved include:**

* `config.toml`
* `data/litesync.db`
* `data/tasks/`
* task history and activity data

---

## Uninstallation

To completely remove LiteSync and its systemd service:

```sh
sudo bash uninstall.sh
```

This removes the LiteSync service, application installation, and dedicated system user.

To uninstall LiteSync while preserving your configuration and application data:

```sh
sudo bash uninstall.sh --keep-data
```

Use `--keep-data` if you intend to reinstall LiteSync later and want to preserve:

* `config.toml`
* `data/`
* SQLite task history
* existing task data

---

## Configuration

LiteSync uses TOML configuration through Python's built-in `tomllib`.

The default configuration file is:

```text
config.toml
```

A different configuration file can be selected using the `LITESYNC_CONFIG` environment variable.

For example:

```sh
export LITESYNC_CONFIG=/path/to/config.toml
```

The configuration should contain at least:

* one or more `allowed_roots`
* a secure `secret_key`
* at least one configured user

### Allowed Roots

Only directories explicitly listed under `allowed_roots` can be accessed by LiteSync.

This applies to:

* directory browsing
* file selection
* transfer sources
* transfer destinations
* browser uploads

Do not add filesystem locations to `allowed_roots` unless LiteSync should have access to them.

---

## Transfer Engines

LiteSync supports two transfer engines.

### Kernel Engine

The Kernel engine uses Python's:

```python
os.copy_file_range()
```

This allows Linux to perform the file copy through the kernel without routing the file contents through Python userspace buffers.

It is intended for fast local filesystem copies where kernel-level copying is appropriate.

### Rsync Engine

The `rsync` engine provides:

* resumable transfers
* robust interruption handling
* reliable directory synchronization
* support for exclusion rules

`rsync` is the default transfer engine.

Transfers containing folder exclusions automatically use `rsync`, since the Kernel engine does not provide equivalent exclusion semantics.

### Same-Filesystem Moves

When a move occurs within the same filesystem, LiteSync bypasses both transfer engines and uses atomic:

```python
os.rename()
```

This avoids unnecessarily copying file data when the filesystem can perform the move directly.

---

## Background Transfers

Transfers run in the background rather than depending on the browser connection remaining open.

This means:

* closing the browser does not cancel an active transfer
* navigating away from the page does not stop the transfer
* temporary browser/network disconnects do not inherently terminate the task
* task state remains available after the transfer starts

The browser communicates with the backend for task status and progress while the actual transfer is performed independently.

---

## Browser Uploads

LiteSync supports direct browser-to-filesystem uploads.

Uploads are streamed rather than loading the complete file into RAM.

The maximum upload size is configurable through:

```text
max_upload_size_mb
```

The default maximum upload size is **5 GB**.

### Temporary Upload Storage

Large uploads are temporarily stored in:

```text
data/tmp
```

before being atomically moved into their final destination.

This disk-backed staging approach prevents large uploads from exhausting Raspberry Pi RAM.

**Important:** The filesystem containing `data/tmp` must have enough free space for the largest upload you intend to perform.

For example, a 5 GB upload may temporarily require approximately 5 GB of additional free disk space in the staging location.

---

## Task Data & Activity History

LiteSync stores persistent task information in:

```text
data/litesync.db
```

Task-related data is stored under:

```text
data/tasks/
```

These records allow transfer history and task state to survive application restarts and service restarts.

Do not delete `data/litesync.db` or `data/tasks/` unless you intentionally want to remove the corresponding historical task data.

The application installation and configuration are intentionally separated from persistent task data so upgrades can be performed without destroying existing task history.

---

## Security

LiteSync is intended for trusted/private networks and should be configured carefully.

### Filesystem Access

LiteSync can only access paths exposed through `allowed_roots`.

Keep this list as restrictive as practical.

### Configuration Permissions

Protect `config.toml` because it contains authentication and application secrets:

```sh
chmod 600 config.toml
```

### Dedicated Service User

The Raspberry Pi installer runs LiteSync under a dedicated `litesync` system account rather than running the application as `root`.

This limits the filesystem permissions available to the application.

### Network Exposure

If LiteSync is exposed beyond a trusted LAN, place it behind an appropriate reverse proxy/VPN and consider adding HTTPS and additional network-level access controls.

---

## Architecture

LiteSync intentionally keeps the backend small.

The application is built around:

* **FastAPI** for the web application/API
* **Uvicorn** as the application server
* **SQLite** for persistent task/activity state
* **rsync** for reliable/resumable transfers
* **`os.copy_file_range`** for zero-copy kernel-assisted local copies
* **Linux `os.rename()`** for same-filesystem moves
* **systemd** for Raspberry Pi service management
* **Python `tomllib`** for configuration

The goal is to provide a lightweight web interface without introducing a large storage-management or synchronization framework.

---

## Troubleshooting

### Check LiteSync Service Status

```sh
sudo systemctl status litesync
```

### View Recent Logs

```sh
sudo journalctl -u litesync --no-pager -n 100
```

### Follow Logs Live

```sh
sudo journalctl -u litesync -f
```

### Restart After Configuration Changes

```sh
sudo systemctl restart litesync
```

### Verify rsync

```sh
rsync --version
```

### Verify Python

```sh
python3 --version
```

LiteSync requires Python 3.11 or newer.

### Check Temporary Upload Storage

If large uploads fail, verify that the filesystem containing:

```text
data/tmp
```

has sufficient free space.

---

## License

LiteSync is released under the MIT License.
