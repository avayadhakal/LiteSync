#!/usr/bin/env bash
#
# uninstall.sh — LiteSync uninstaller
#
# Stops and removes the systemd service (litesync.service), deletes the application
# directory (/opt/litesync), and removes the dedicated `litesync` system user.
#
# Usage:
#     sudo bash uninstall.sh            # Purges everything (complete uninstallation)
#     sudo bash uninstall.sh --keep-data # Keeps /opt/litesync/data and config.toml
#

set -euo pipefail

for arg in "$@"; do
    case "${arg}" in
        -h|--help)
            echo "Usage: sudo bash uninstall.sh [OPTIONS]"
            echo
            echo "Options:"
            echo "  --keep-data    Keep /opt/litesync/data (database & task logs) and config.toml"
            echo "  -h, --help     Show this help message"
            exit 0
            ;;
    esac
done

# ---------------------------------------------------------------------------
# 0. Root check
# ---------------------------------------------------------------------------
if [[ "${EUID}" -ne 0 ]]; then
    echo "This script needs root privileges (systemctl, userdel, rm)."
    echo "Re-running with sudo..."
    exec sudo bash "$0" "$@"
fi

INSTALL_DIR="/opt/litesync"
SERVICE_NAME="litesync"
SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"

KEEP_DATA=false
for arg in "$@"; do
    case "${arg}" in
        --keep-data)
            KEEP_DATA=true
            ;;
    esac
done

log()  { printf '\033[1;32m[+]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[!]\033[0m %s\n' "$*" >&2; }

log "Starting LiteSync uninstallation..."

# ---------------------------------------------------------------------------
# 1. Stop and disable systemd service
# ---------------------------------------------------------------------------
if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    log "Stopping ${SERVICE_NAME}.service..."
    systemctl stop "${SERVICE_NAME}" || true
fi

if systemctl is-enabled --quiet "${SERVICE_NAME}" 2>/dev/null; then
    log "Disabling ${SERVICE_NAME}.service..."
    systemctl disable "${SERVICE_NAME}" || true
fi

if [[ -f "${SERVICE_FILE}" ]]; then
    log "Removing ${SERVICE_FILE}..."
    rm -f "${SERVICE_FILE}"
    systemctl daemon-reload || true
    systemctl reset-failed "${SERVICE_NAME}" 2>/dev/null || true
fi

# ---------------------------------------------------------------------------
# 2. Remove application files
# ---------------------------------------------------------------------------
if [[ -d "${INSTALL_DIR}" ]]; then
    if [[ "${KEEP_DATA}" == "true" ]]; then
        log "Removing application code while preserving data and config in ${INSTALL_DIR}..."
        rm -rf "${INSTALL_DIR}/app" "${INSTALL_DIR}/static" "${INSTALL_DIR}/.venv" \
               "${INSTALL_DIR}/requirements.txt" "${INSTALL_DIR}/config.example.toml"
    else
        log "Removing entire application directory ${INSTALL_DIR}..."
        rm -rf "${INSTALL_DIR}"
    fi
else
    log "${INSTALL_DIR} does not exist — skipping directory removal."
fi

# ---------------------------------------------------------------------------
# 3. Remove system user & group
# ---------------------------------------------------------------------------
if id "${SERVICE_NAME}" &>/dev/null; then
    log "Removing system user '${SERVICE_NAME}'..."
    userdel "${SERVICE_NAME}" 2>/dev/null || true
fi

if getent group "${SERVICE_NAME}" &>/dev/null; then
    log "Removing system group '${SERVICE_NAME}'..."
    groupdel "${SERVICE_NAME}" 2>/dev/null || true
fi

echo
log "LiteSync has been successfully uninstalled from this system."
if [[ "${KEEP_DATA}" == "true" ]]; then
    log "Preserved data directory and config at: ${INSTALL_DIR}"
fi
