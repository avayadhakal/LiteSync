# LiteSync

Ultra-lightweight dual-pane file transfer web app for a Raspberry Pi. Browse a
source and destination directory side by side, select files/folders, and hand
the transfer to `rsync` running inside a detached `tmux` session so it survives
closing the browser.

## Requirements

- Python 3.10+
- `rsync`, `tmux` installed on the host
- `python3-venv`

## Setup (development or Pi)

```sh
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt

cp config.example.yaml config.yaml
# Edit config.yaml: set allowed_roots, secret_key, and at least one user.

python -c "import secrets; print(secrets.token_hex(32))"   # -> secret_key
python -m app.auth hash "yourpassword"                      # -> password_hash

chmod 600 config.yaml

uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 1
```

Visit `http://<host>:8000/`.

## Deploying on a Raspberry Pi as a service

```sh
sudo useradd --system --home /opt/litesync --shell /usr/sbin/nologin litesync
sudo mkdir -p /opt/litesync
sudo cp -r . /opt/litesync
cd /opt/litesync
sudo python3 -m venv .venv
sudo .venv/bin/pip install -r requirements.txt
sudo chown -R litesync:litesync /opt/litesync
```

Edit `litesync.service`'s `ReadWritePaths` line to also list every directory
under `allowed_roots` in `config.yaml`, then:

```sh
sudo cp litesync.service /etc/systemd/system/litesync.service
sudo systemctl daemon-reload
sudo systemctl enable --now litesync
```

## Notes

- Only directories listed under `allowed_roots` in `config.yaml` can be
  browsed or used as a transfer source/destination.
- Transfers run as: `rsync -avh --progress --partial --inplace <sources...> <destination>`,
  with `--remove-source-files` appended when "Delete source files after
  successful copy" is checked. When that option is used, now-empty source
  subfolders are pruned afterward (scoped to each selected item — it cannot
  delete anything above what you selected).
- Each transfer runs in its own `tmux -L litesync` session and is
  self-terminating; `tmux -L litesync ls` shows only in-flight transfers.
- If the server restarts mid-transfer, the `tmux` session (and rsync) keeps
  running; on the next startup LiteSync reconciles history against any
  sessions still alive.
