#!/usr/bin/env bash
#
# deploy.sh — LiteSync Raspberry Pi deployment helper
#
# Stages LiteSync from this git repository into /opt/litesync, creates the
# dedicated `litesync` system user, manages the virtual environment, generates
# a hardened systemd unit, and restarts the service.
#
# Usage (on the Pi, from the cloned repo):
#     git clone <your-repo-url> LiteSync && cd LiteSync
#     sudo bash deploy.sh
#
# Re-running the script is safe (idempotent): it updates backend/UI code and
# pip packages while strictly preserving your existing database (litesync.db),
# task logs (data/tasks/), and configuration (config.yaml).

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
# 1. Stop service gracefully before updating code (if already running)
# ---------------------------------------------------------------------------
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    log "Stopping ${SERVICE_NAME}.service before staging updates..."
    systemctl stop "${SERVICE_NAME}"
fi

# ---------------------------------------------------------------------------
# 2. System dependencies
# ---------------------------------------------------------------------------
log "Checking system dependencies (rsync, python3-venv)..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y --no-install-recommends rsync python3-venv

PY_MINOR="$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')"
log "System python3: ${PY_MINOR}"

# ---------------------------------------------------------------------------
# 3. Dedicated service user
# ---------------------------------------------------------------------------
if id "${SERVICE_NAME}" &>/dev/null; then
    log "User '${SERVICE_NAME}' already exists — skipping creation."
else
    log "Creating system user '${SERVICE_NAME}' (nologin shell)..."
    useradd --system --home-dir "${INSTALL_DIR}" --shell /usr/sbin/nologin "${SERVICE_NAME}"
fi

# ---------------------------------------------------------------------------
# 4. Stage the application into /opt/litesync
# ---------------------------------------------------------------------------
install -d -m 0755 "${INSTALL_DIR}"

if [[ "${SCRIPT_DIR}" != "${INSTALL_DIR}" ]]; then
    log "Staging application code into ${INSTALL_DIR}..."
    cp -r "${SCRIPT_DIR}/app" "${SCRIPT_DIR}/static" "${INSTALL_DIR}/"
    cp "${SCRIPT_DIR}/requirements.txt" "${SCRIPT_DIR}/config.example.yaml" "${INSTALL_DIR}/"
    # Drop any stale bytecode that may have come along from a dev machine.
    find "${INSTALL_DIR}/app" -name '__pycache__' -type d -prune -exec rm -rf {} +
fi

# --- config.yaml (Preserve existing active config; never overwrite) ---
if [[ -f "${INSTALL_DIR}/config.yaml" ]]; then
    log "Keeping existing active ${INSTALL_DIR}/config.yaml (credentials & settings preserved)."
    CONFIG_SEEDED=false
elif [[ -f "${SCRIPT_DIR}/config.yaml" ]]; then
    log "Found config.yaml in repository — installing it to ${INSTALL_DIR}/config.yaml."
    install -m 0600 "${SCRIPT_DIR}/config.yaml" "${INSTALL_DIR}/config.yaml"
    CONFIG_SEEDED=false
else
    warn "No config.yaml found — seeding from config.example.yaml with a fresh random secret_key."
    install -m 0600 "${INSTALL_DIR}/config.example.yaml" "${INSTALL_DIR}/config.yaml"
    CONFIG_SEEDED=true
fi

# --- Data directory (Database + task logs) ---
# Ensure data directory exists with correct permissions without altering existing database/logs.
if [[ -d "${INSTALL_DIR}/data" ]]; then
    log "Preserving existing data directory at ${INSTALL_DIR}/data (database & task logs intact)."
else
    log "Creating initial data directory at ${INSTALL_DIR}/data..."
    install -d -m 0755 "${INSTALL_DIR}/data"
fi

# ---------------------------------------------------------------------------
# 5. Virtual environment (Fast incremental update)
# ---------------------------------------------------------------------------
VENV_PY="${INSTALL_DIR}/.venv/bin/python"
if [[ -x "${VENV_PY}" ]]; then
    log "Updating virtual environment packages in ${INSTALL_DIR}/.venv..."
    "${VENV_PY}" -m pip install -q -r "${INSTALL_DIR}/requirements.txt"
else
    log "Building fresh virtual environment at ${INSTALL_DIR}/.venv (first-time setup)..."
    python3 -m venv "${INSTALL_DIR}/.venv"
    "${VENV_PY}" -m pip install --no-cache-dir -r "${INSTALL_DIR}/requirements.txt"
fi

# ---------------------------------------------------------------------------
# 6. Read host/port/allowed_roots from the staged config.yaml
# ---------------------------------------------------------------------------
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
# 7. Generate the systemd unit
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
# 8. Ownership, activation, verification
# ---------------------------------------------------------------------------
log "Setting ownership to ${SERVICE_NAME}:${SERVICE_NAME}..."
chown -R "${SERVICE_NAME}:${SERVICE_NAME}" "${INSTALL_DIR}"
chmod 600 "${INSTALL_DIR}/config.yaml"
chmod 755 "${INSTALL_DIR}/data"

log "Enabling & restarting ${SERVICE_NAME}.service with latest code..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

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
# 9. Post-install checklist (only if we had to seed a placeholder config)
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
