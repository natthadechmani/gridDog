#!/usr/bin/env bash
# setup-backend.sh
# Build and deploy the Go backend as a systemd service on a VM.
# Run as root or with sudo: sudo bash setup-backend.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override via environment variables before running
# ---------------------------------------------------------------------------
GO_VERSION="${GO_VERSION:-1.21.9}"
GRIDDOG_DIR="${GRIDDOG_DIR:-/opt/griddog}"
BACKEND_SRC="${GRIDDOG_DIR}/backend"       # directory containing go.mod
BINARY_DIR="/usr/local/bin"
BINARY_NAME="griddog-backend"
SERVICE_USER="griddog"
SERVICE_NAME="griddog-backend"

# Service environment variables
BACKEND_PORT="${BACKEND_PORT:-8080}"
JAVA_SERVICE_URL="${JAVA_SERVICE_URL:-http://java-service:8081}"
EXPRESS_SERVICE_URL="${EXPRESS_SERVICE_URL:-http://express-service:3001}"
DATABASE_URL="${DATABASE_URL:-postgres://griddog:griddog@localhost:5432/griddog?sslmode=disable}"

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
# Install Go
# ---------------------------------------------------------------------------
install_go() {
  local go_root="/usr/local/go"
  local go_bin="${go_root}/bin/go"

  if [[ -x "${go_bin}" ]]; then
    local installed_ver
    installed_ver="$("${go_bin}" version | awk '{print $3}' | sed 's/go//')"
    if [[ "${installed_ver}" == "${GO_VERSION}" ]]; then
      log "Go ${GO_VERSION} already installed; skipping."
      return
    fi
    log "Removing existing Go installation (found ${installed_ver})..."
    rm -rf "${go_root}"
  fi

  local arch
  arch="$(dpkg --print-architecture)"
  # Map Debian arch names to Go arch names
  case "${arch}" in
    amd64) GO_ARCH="amd64" ;;
    arm64) GO_ARCH="arm64" ;;
    *)     echo "Unsupported architecture: ${arch}" >&2; exit 1 ;;
  esac

  local tarball="go${GO_VERSION}.linux-${GO_ARCH}.tar.gz"
  local url="https://go.dev/dl/${tarball}"

  log "Downloading Go ${GO_VERSION} from ${url}..."
  curl -fsSL "${url}" -o "/tmp/${tarball}"
  log "Installing Go to ${go_root}..."
  tar -C /usr/local -xzf "/tmp/${tarball}"
  rm "/tmp/${tarball}"

  # Ensure /usr/local/go/bin is on PATH for subsequent commands in this script
  export PATH="/usr/local/go/bin:${PATH}"
  log "Go $(go version) installed."
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
require_root

log "Installing build dependencies..."
apt-get update -y
apt-get install -y curl git build-essential

install_go

# Ensure griddog user exists (setup-common.sh normally creates it, but be safe)
if ! id "${SERVICE_USER}" &>/dev/null; then
  log "Creating user '${SERVICE_USER}'..."
  useradd --system --shell /bin/bash --create-home "${SERVICE_USER}"
fi

# ---------------------------------------------------------------------------
# Build the binary
# ---------------------------------------------------------------------------
if [[ ! -d "${BACKEND_SRC}" ]]; then
  echo "ERROR: Backend source directory '${BACKEND_SRC}' not found." \
       "Run setup-common.sh first to clone the repository." >&2
  exit 1
fi

log "Building Go backend from ${BACKEND_SRC}..."
export PATH="/usr/local/go/bin:${PATH}"
(
  cd "${BACKEND_SRC}"
  CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o "/tmp/${BINARY_NAME}" .
)

log "Installing binary to ${BINARY_DIR}/${BINARY_NAME}..."
install -m 755 "/tmp/${BINARY_NAME}" "${BINARY_DIR}/${BINARY_NAME}"
rm -f "/tmp/${BINARY_NAME}"

# ---------------------------------------------------------------------------
# Create systemd service
# ---------------------------------------------------------------------------
log "Creating systemd service /etc/systemd/system/${SERVICE_NAME}.service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GridDog Go Backend Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=${BINARY_DIR}/${BINARY_NAME}
Restart=on-failure
RestartSec=5s

# Environment variables
Environment="PORT=${BACKEND_PORT}"
Environment="JAVA_SERVICE_URL=${JAVA_SERVICE_URL}"
Environment="EXPRESS_SERVICE_URL=${EXPRESS_SERVICE_URL}"
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

log "setup-backend.sh completed successfully."
