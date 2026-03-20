#!/usr/bin/env bash
# setup-java.sh
# Deploy the Spring Boot Java service as a systemd service on a VM.
# Expects a pre-built JAR to be present (built by CI or copied to the VM).
# Run as root or with sudo: sudo bash setup-java.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration — override via environment variables before running
# ---------------------------------------------------------------------------
GRIDDOG_DIR="${GRIDDOG_DIR:-/opt/griddog}"
# Path to the pre-built fat JAR. Adjust to match your CI artifact location.
JAR_SRC="${JAR_SRC:-${GRIDDOG_DIR}/java-service/build/libs/java-service.jar}"
JAR_DEST="/opt/griddog-java/java-service.jar"
SERVICE_USER="griddog"
SERVICE_NAME="griddog-java"

# Service environment variables
JAVA_PORT="${JAVA_PORT:-8081}"
DATABASE_URL="${DATABASE_URL:-jdbc:postgresql://localhost:5432/griddog}"
DB_USER="${DB_USER:-griddog}"
DB_PASSWORD="${DB_PASSWORD:-griddog}"
SPRING_PROFILES_ACTIVE="${SPRING_PROFILES_ACTIVE:-production}"

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
# Install OpenJDK 17
# ---------------------------------------------------------------------------
log "Installing OpenJDK 17..."
apt-get update -y
apt-get install -y openjdk-17-jdk-headless curl

JAVA_BIN="$(update-alternatives --list java | grep java-17 | head -1)"
if [[ -z "${JAVA_BIN}" ]]; then
  # Fallback: use whatever java is on PATH after install
  JAVA_BIN="$(which java)"
fi
log "Using Java: $("${JAVA_BIN}" -version 2>&1 | head -1)"

# ---------------------------------------------------------------------------
# Ensure griddog user exists
# ---------------------------------------------------------------------------
if ! id "${SERVICE_USER}" &>/dev/null; then
  log "Creating user '${SERVICE_USER}'..."
  useradd --system --shell /bin/bash --create-home "${SERVICE_USER}"
fi

# ---------------------------------------------------------------------------
# Copy JAR
# ---------------------------------------------------------------------------
log "Creating JAR destination directory /opt/griddog-java..."
mkdir -p /opt/griddog-java
chown "${SERVICE_USER}:${SERVICE_USER}" /opt/griddog-java

if [[ ! -f "${JAR_SRC}" ]]; then
  echo "ERROR: JAR file not found at '${JAR_SRC}'." \
       "Build the project first or set JAR_SRC to the correct path." >&2
  exit 1
fi

log "Copying JAR from ${JAR_SRC} to ${JAR_DEST}..."
install -m 644 -o "${SERVICE_USER}" -g "${SERVICE_USER}" "${JAR_SRC}" "${JAR_DEST}"

# ---------------------------------------------------------------------------
# Create systemd service
# ---------------------------------------------------------------------------
log "Creating systemd service /etc/systemd/system/${SERVICE_NAME}.service..."
cat > "/etc/systemd/system/${SERVICE_NAME}.service" <<EOF
[Unit]
Description=GridDog Java (Spring Boot) Service
After=network.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
ExecStart=/usr/bin/java \
  -Xms128m \
  -Xmx512m \
  -jar ${JAR_DEST}
Restart=on-failure
RestartSec=10s

# Environment variables
Environment="SERVER_PORT=${JAVA_PORT}"
Environment="SPRING_DATASOURCE_URL=${DATABASE_URL}"
Environment="SPRING_DATASOURCE_USERNAME=${DB_USER}"
Environment="SPRING_DATASOURCE_PASSWORD=${DB_PASSWORD}"
Environment="SPRING_PROFILES_ACTIVE=${SPRING_PROFILES_ACTIVE}"

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

log "Waiting for JVM to warm up (15 s)..."
sleep 15
systemctl status "${SERVICE_NAME}" --no-pager

log "setup-java.sh completed successfully."
