#!/usr/bin/env bash
# setup-frontend.sh
# Build and deploy the Next.js frontend as a systemd service on a VM.
# Run as root or with sudo: sudo bash setup-frontend.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override via environment variables before running
# ---------------------------------------------------------------------------
NODE_MAJOR="${NODE_MAJOR:-20}"
GRIDDOG_DIR="${GRIDDOG_DIR:-/opt/griddog}"
APP_DIR="${GRIDDOG_DIR}/frontend"
SERVICE_USER="griddog"
SERVICE_NAME="griddog-frontend"

# Service environment variables
NEXT_PORT="${NEXT_PORT:-3000}"
NODE_ENV="${NODE_ENV:-production}"
# IMPORTANT: Set this to the public-facing URL of your backend API before running.
NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL:-http://REPLACE_WITH_BACKEND_URL}"

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

# Warn if placeholder URL has not been replaced
if [[ "${NEXT_PUBLIC_BACKEND_URL}" == "http://REPLACE_WITH_BACKEND_URL" ]]; then
  echo "WARNING: NEXT_PUBLIC_BACKEND_URL is still set to the placeholder value." \
       "Set it to the real backend URL before running this script, e.g.:" \
       "  NEXT_PUBLIC_BACKEND_URL=http://my-backend.example.com bash setup-frontend.sh" >&2
fi

# ---------------------------------------------------------------------------
# Install Node.js 20 via NodeSource
# ---------------------------------------------------------------------------
if command -v node &>/dev/null; then
  INSTALLED_MAJOR="$(node --version | sed 's/v//' | cut -d. -f1)"
  if [[ "${INSTALLED_MAJOR}" -ge "${NODE_MAJOR}" ]]; then
    log "Node.js $(node --version) already installed; skipping."
  else
    log "Upgrading Node.js from $(node --version) to v${NODE_MAJOR}..."
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
# Install dependencies and build
# ---------------------------------------------------------------------------
if [[ ! -d "${APP_DIR}" ]]; then
  echo "ERROR: Frontend source not found at '${APP_DIR}'." \
       "Run setup-common.sh first to clone the repository." >&2
  exit 1
fi

log "Fixing ownership of ${APP_DIR}..."
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${APP_DIR}"

log "Running npm install in ${APP_DIR}..."
sudo -u "${SERVICE_USER}" npm --prefix "${APP_DIR}" ci

log "Building Next.js application (NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL})..."
sudo -u "${SERVICE_USER}" env \
  NEXT_PUBLIC_BACKEND_URL="${NEXT_PUBLIC_BACKEND_URL}" \
  NODE_ENV=production \
  npm --prefix "${APP_DIR}" run build

# ---------------------------------------------------------------------------
# Create systemd service
# ---------------------------------------------------------------------------
NODE_BIN="$(which node)"
NPM_BIN="$(which npm)"

log "Creating systemd service /etc/systemd/system/${SERVICE_NAME}.service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GridDog Next.js Frontend Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NPM_BIN} --prefix ${APP_DIR} run start
Restart=on-failure
RestartSec=5s

# Environment variables
# NOTE: NEXT_PUBLIC_* vars are baked into the build at build time.
# Changing them here requires a rebuild (re-run this script).
Environment="PORT=${NEXT_PORT}"
Environment="NODE_ENV=${NODE_ENV}"
Environment="NEXT_PUBLIC_BACKEND_URL=${NEXT_PUBLIC_BACKEND_URL}"

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

log "Waiting for Next.js to start (5 s)..."
sleep 5
systemctl status "${SERVICE_NAME}" --no-pager

log "setup-frontend.sh completed successfully."
log "Frontend is listening on port ${NEXT_PORT}."
