#!/usr/bin/env bash
#
# deploy.sh — LiteSync Raspberry Pi deployment helper
#
# Stages LiteSync from this (freshly cloned) git repository into /opt/litesync,
# creates the dedicated `litesync` system user, builds a fresh aarch64
# virtual environment, generates a hardened systemd unit, and starts it.
#
# Usage (on the Pi, from the cloned repo):
#     git clone <your-repo-url> LiteSync && cd LiteSync
#     sudo bash deploy.sh
#
# Re-running the script is safe (idempotent): it refreshes the code, rebuilds
# the venv, regenerates the unit file, and restarts the service. An already
# configured /opt/litesync/config.yaml is never overwritten — unless you
# place a config.yaml inside this repo, which then becomes the source of truth.

set -euo pipefail

# ---------------------------------------------------------------------------
# 0. Root check
# ---------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    echo "This script needs root privileges (apt, useradd, /opt, systemd)."
    echo "Re-running with sudo..."
    exec sudo bash "$0" "$@"
fi

INSTALL_DIR="/opt/litesync"
SERVICE_NAME="litesync"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[x]\033[0m %s\n' "$*" >&2; exit 1; }

# Sanity: make sure we are actually inside the LiteSync repo.
[[ -d "${SCRIPT_DIR}/app" && -d "${SCRIPT_DIR}/static" \
   && -f "${SCRIPT_DIR}/requirements.txt" && -f "${SCRIPT_DIR}/config.example.yaml" ]] \
    || die "deploy.sh must live in (and run from) the LiteSync repository root."

# ---------------------------------------------------------------------------
# 1. System dependencies
# ---------------------------------------------------------------------------
log "Installing system dependencies (rsync, python3-venv)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends rsync python3-venv

# Older Raspberry Pi OS (bullseye) ships Python 3.9; LiteSync targets 3.9+.
PY_MINOR="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
log "System python3: ${PY_MINOR}"

# ---------------------------------------------------------------------------
# 2. Dedicated service user
# ---------------------------------------------------------------------------
if id "${SERVICE_NAME}" &>/dev/null; then
    log "User '${SERVICE_NAME}' already exists — skipping creation."
else
    log "Creating system user '${SERVICE_NAME}' (nologin shell)..."
    useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_NAME}"
fi

# ---------------------------------------------------------------------------
# 3. Stage the application into /opt/litesync
# ---------------------------------------------------------------------------
log "Staging application into ${INSTALL_DIR}..."
install -d -m 0755 "${INSTALL_DIR}"

# Copy application code and assets. (cp of explicit paths keeps the x86-64
# .venv, .git, and local data/ out of the staging area.)
cp -r "${SCRIPT_DIR}/app" "${SCRIPT_DIR}/static" "${INSTALL_DIR}/"
cp "${SCRIPT_DIR}/requirements.txt" "${SCRIPT_DIR}/config.example.yaml" "${INSTALL_DIR}/"
# Drop any stale bytecode that may have come along from a dev machine.
find "${INSTALL_DIR}/app" -name '__pycache__' -type d -prune -exec rm -rf {} +

# --- config.yaml (gitignored, so it is normally absent from a fresh clone) ---
if [[ -f "${SCRIPT_DIR}/config.yaml" ]]; then
    # The user prepared a real config next to the clone: it is the source of truth.
    log "Found config.yaml in the repo — installing it."
    install -m 0600 "${SCRIPT_DIR}/config.yaml" "${INSTALL_DIR}/config.yaml"
    CONFIG_SEEDED=false
elif [[ -f "${INSTALL_DIR}/config.yaml" ]]; then
    log "Keeping existing ${INSTALL_DIR}/config.yaml (never overwriting a configured one)."
    CONFIG_SEEDED=false
else
    warn "No config.yaml found — seeding from config.example.yaml with a fresh random secret_key."
    install -m 0600 "${INSTALL_DIR}/config.example.yaml" "${INSTALL_DIR}/config.yaml"
    CONFIG_SEEDED=true
fi

# Database + per-task logs live here (config.yaml's data_dir: ./data resolves
# relative to WorkingDirectory, i.e. /opt/litesync/data).
install -d -m 0755 "${INSTALL_DIR}/data"

# ---------------------------------------------------------------------------
# 4. Fresh aarch64 virtual environment
# ---------------------------------------------------------------------------
# Never copy a venv from another machine: bcrypt/pydantic-core ship native
# extensions compiled for the build host's architecture. Build it here, on
# the Pi.
log "Building fresh virtual environment at ${INSTALL_DIR}/.venv (this can take a few minutes on a Pi)..."
rm -rf "${INSTALL_DIR}/.venv"
python3 -m venv "${INSTALL_DIR}/.venv"
VENV_PY="${INSTALL_DIR}/.venv/bin/python"
"${VENV_PY}" -m pip install --no-cache-dir -r "${INSTALL_DIR}/requirements.txt"

# ---------------------------------------------------------------------------
# 5. Read host/port/allowed_roots from the staged config.yaml
# ---------------------------------------------------------------------------
# The uvicorn --host/--port flags override anything in config.yaml, so we read
# the config values here and pass them explicitly — the two can never drift.
read -r HOST PORT < <("${VENV_PY}" - <<PYEOF
import yaml
d = yaml.safe_load(open("${INSTALL_DIR}/config.yaml"))
print(d.get("host", "0.0.0.0"), int(d.get("port", 8000)))
PYEOF
)

mapfile -t ALLOWED_ROOTS < <("${VENV_PY}" - <<PYEOF
import yaml
d = yaml.safe_load(open("${INSTALL_DIR}/config.yaml"))
for r in (d.get("allowed_roots") or []):
    print(r)
PYEOF
)

[[ ${#ALLOWED_ROOTS[@]} -gt 0 ]] || die "config.yaml has no allowed_roots."

# If we just seeded from the example, bake in a real random secret_key now.
if [[ "${CONFIG_SEEDED}" == "true" ]]; then
    SECRET="$("${VENV_PY}" -c 'import secrets; print(secrets.token_hex(32))')"
    sed -i "s|^secret_key:.*|secret_key: \"${SECRET}\"|" "${INSTALL_DIR}/config.yaml"
fi

# Build the ReadWritePaths lines: the data dir (SQLite + task logs) plus every
# configured allowed_root (rsync needs to write destinations there, and the
# delete-after-copy feature needs to delete sources there). ProtectSystem=strict
# leaves everything else read-only.
RW_LINES="ReadWritePaths=${INSTALL_DIR}/data"
declare -A _seen=("${INSTALL_DIR}/data"=1)
for root in "${ALLOWED_ROOTS[@]}"; do
    [[ -z "${root}" ]] && continue
    case "${root}" in
        "${INSTALL_DIR}"/*) continue ;;  # already covered
    esac
    if [[ -n "${_seen[${root}]:-}" ]]; then continue; fi
    _seen["${root}"]=1
    RW_LINES+=$'\n'"ReadWritePaths=${root}"
    if [[ ! -d "${root}" ]]; then
        warn "allowed_root '${root}' does not exist (drive not mounted?)." \
             "Systemd will skip it, but transfers will fail until it exists."
    fi
done

# ---------------------------------------------------------------------------
# 6. Generate the systemd unit
# ---------------------------------------------------------------------------
log "Generating ${SERVICE_FILE} (host=${HOST} port=${PORT})..."
cat > "${SERVICE_FILE}" <<EOF
[Unit]
Description=LiteSync file transfer web app
After=network-online.target local-fs.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_NAME}
Group=${SERVICE_NAME}
WorkingDirectory=${INSTALL_DIR}
Environment=LITESYNC_CONFIG=${INSTALL_DIR}/config.yaml
Environment=PYTHONUNBUFFERED=1
ExecStart=${INSTALL_DIR}/.venv/bin/uvicorn app.main:app --host ${HOST} --port ${PORT} --workers 1
Restart=on-failure
RestartSec=5

# Security boundaries. Safe to use ProtectHome=true now because the app lives
# entirely in /opt — nothing it needs is under /home.
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true

# ProtectSystem=strict makes the whole filesystem read-only except the paths
# below. The data dir needs write (SQLite + logs); every allowed_root needs
# write (rsync destination writes + delete-after-copy source pruning).
${RW_LINES}

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# 7. Ownership, activation, verification
# ---------------------------------------------------------------------------
log "Setting ownership to ${SERVICE_NAME}:${SERVICE_NAME}..."
chown -R "${SERVICE_NAME}:${SERVICE_NAME}" "${INSTALL_DIR}"
chmod 600 "${INSTALL_DIR}/config.yaml"

log "Enabling + starting ${SERVICE_NAME}.service..."
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}"

sleep 2
echo
if systemctl is-active --quiet "${SERVICE_NAME}"; then
    log "Service is UP. Status:"
    systemctl status "${SERVICE_NAME}" --no-pager -l | head -n 12 || true
    echo
    log "Open the app at: http://<pi-ip>:${PORT}"
    log "Follow logs with: journalctl -u ${SERVICE_NAME} -f"
else
    warn "Service is NOT active. Inspect with:"
    echo "    systemctl status ${SERVICE_NAME} -l"
    echo "    journalctl -u ${SERVICE_NAME} -n 50 --no-pager"
    exit 1
fi

# ---------------------------------------------------------------------------
# 8. Post-install checklist (only if we had to seed a placeholder config)
# ---------------------------------------------------------------------------
if [[ "${CONFIG_SEEDED}" == "true" ]]; then
    echo
    warn "IMPORTANT: ${INSTALL_DIR}/config.yaml was seeded from config.example.yaml"
    warn "(a random secret_key was generated, but logins/roots are placeholders)."
    echo
    echo "  Finish the setup:"
    echo "    1. Generate a password hash:"
    echo "         cd ${INSTALL_DIR} && sudo -u ${SERVICE_NAME} .venv/bin/python -m app.auth hash \"yourpassword\""
    echo "    2. Edit ${INSTALL_DIR}/config.yaml:"
    echo "         - paste the hash into users[].password_hash"
    echo "         - set allowed_roots to your real drives (e.g. /mnt/ssd, /mnt/homelab_nfs)"
    echo "    3. Re-run 'sudo bash deploy.sh' (it regenerates the unit's ReadWritePaths"
    echo "       to match the new roots WITHOUT touching your edited config), or simply:"
    echo "         sudo bash deploy.sh"
    echo
fi
