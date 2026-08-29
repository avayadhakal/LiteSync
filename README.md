# LiteSync

Ultra-lightweight dual-pane file transfer web app for a Raspberry Pi. Browse a
source and destination directory side by side, select files/folders, and hand
the transfer to `rsync` running in the background so it survives
closing the browser. Also supports direct, streamed browser-to-filesystem file uploads
with real-time byte-level progress.

## Requirements

- Python 3.11+
- `rsync` installed on the host
- `python3-venv`

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
```

Visit `http://<host>:8000/`.

## Automated Installation & Service Setup (Raspberry Pi)

LiteSync includes an automated installer that stages the application to `/opt/litesync`, creates the `litesync` system user, manages the virtual environment, configures a hardened systemd service, and starts it:

```sh
# Clone and install
git clone <your-repo-url> LiteSync
cd LiteSync
sudo bash install.sh
```

Re-running `sudo bash install.sh` is safe and idempotent: it updates application code and dependencies while strictly preserving your existing database (`litesync.db`), task logs (`data/tasks/`), and configuration (`config.toml`).

## Uninstallation

To completely remove LiteSync and its systemd service from the system:

```sh
sudo bash uninstall.sh            # Purges service, files, and user
sudo bash uninstall.sh --keep-data # Uninstalls but preserves data/ and config.toml
```

## Notes

- Only directories listed under `allowed_roots` in `config.toml` can be
  browsed or used as a transfer source/destination.
- Transfers run in the background as asynchronous subprocesses and survive browser disconnects.
- Browser file uploads stream straight to destination disks in chunks with collision guards and real-time progress (`max_upload_size_mb` configurable in `config.toml`, default 5 GB).
- Configuration is loaded via Python's built-in `tomllib` from `config.toml` (or the path set in `LITESYNC_CONFIG`).
