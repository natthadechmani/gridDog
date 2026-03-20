#!/usr/bin/env bash
# setup-express.sh
# Deploy the Express.js service as a systemd service on a VM using Node.js 20.
# Run as root or with sudo: sudo bash setup-express.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override via environment variables before running
# ---------------------------------------------------------------------------
NODE_MAJOR="${NODE_MAJOR:-20}"
GRIDDOG_DIR="${GRIDDOG_DIR:-/opt/griddog}"
APP_DIR="${GRIDDOG_DIR}/express-service"
SERVICE_USER="griddog"
SERVICE_NAME="griddog-express"

# Service environment variables
EXPRESS_PORT="${EXPRESS_PORT:-3001}"
NODE_ENV="${NODE_ENV:-production}"
DATABASE_URL="${DATABASE_URL:-postgres://griddog:griddog@localhost:5432/griddog?sslmode=disable}"
# Add more env vars as needed for your Express service

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "ERROR: This script must be run as root or via sudo." >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
require_root

# ---------------------------------------------------------------------------
# Install Node.js 20 via NodeSource
# ---------------------------------------------------------------------------
if command -v node &>/dev/null; then
  INSTALLED_MAJOR="$(node --version | sed 's/v//' | cut -d. -f1)"
  if [[ "${INSTALLED_MAJOR}" -ge "${NODE_MAJOR}" ]]; then
    log "Node.js $(node --version) already installed; skipping."
  else
    log "Found older Node.js $(node --version); upgrading to v${NODE_MAJOR}..."
    INSTALL_NODE=true
  fi
else
  INSTALL_NODE=true
fi

if [[ "${INSTALL_NODE:-false}" == "true" ]]; then
  log "Installing Node.js ${NODE_MAJOR}.x via NodeSource repository..."
  apt-get update -y
  apt-get install -y curl ca-certificates gnupg

  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | bash -

  apt-get install -y nodejs
  log "Installed: $(node --version) / npm $(npm --version)"
fi

# ---------------------------------------------------------------------------
# Ensure griddog user exists
# ---------------------------------------------------------------------------
if ! id "${SERVICE_USER}" &>/dev/null; then
  log "Creating user '${SERVICE_USER}'..."
  useradd --system --shell /bin/bash --create-home "${SERVICE_USER}"
fi

# ---------------------------------------------------------------------------
# Install npm dependencies
# ---------------------------------------------------------------------------
if [[ ! -d "${APP_DIR}" ]]; then
  echo "ERROR: Express service source not found at '${APP_DIR}'." \
       "Run setup-common.sh first to clone the repository." >&2
  exit 1
fi

log "Running npm install in ${APP_DIR}..."
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"
sudo -u "${SERVICE_USER}" npm --prefix "${APP_DIR}" ci --omit=dev

# ---------------------------------------------------------------------------
# Create systemd service
# ---------------------------------------------------------------------------
NODE_BIN="$(which node)"

log "Creating systemd service /etc/systemd/system/${SERVICE_NAME}.service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GridDog Express.js Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} ${APP_DIR}/src/index.js
Restart=on-failure
RestartSec=5s

# Environment variables
Environment="PORT=${EXPRESS_PORT}"
Environment="NODE_ENV=${NODE_ENV}"
Environment="DATABASE_URL=${DATABASE_URL}"

# Security hardening
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
EOF

# ---------------------------------------------------------------------------
# Enable and start service
# ---------------------------------------------------------------------------
log "Reloading systemd and starting ${SERVICE_NAME}..."
systemctl daemon-reload
systemctl enable "${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}"

log "Waiting for service to stabilise..."
sleep 3
systemctl status "${SERVICE_NAME}" --no-pager

log "setup-express.sh completed successfully."
