#!/usr/bin/env bash
# setup-common.sh
# Common VM bootstrap: Docker, git, curl, jq, firewall rules, griddog user/directory.
# Run as root or with sudo: sudo bash setup-common.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
GRIDDOG_USER="griddog"
GRIDDOG_DIR="/opt/griddog"
REPO_URL="https://github.com/YOUR_ORG/griddog.git"   # <-- replace with actual repo URL
REPO_BRANCH="main"

# ---------------------------------------------------------------------------
# Helper
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

log "Updating apt package index..."
apt-get update -y

log "Installing prerequisites (ca-certificates, curl, gnupg, lsb-release)..."
apt-get install -y \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  jq \
  ufw

# ---------------------------------------------------------------------------
# Docker CE
# ---------------------------------------------------------------------------
log "Adding Docker's official GPG key and repository..."
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list

log "Installing Docker CE and docker-compose-plugin..."
apt-get update -y
apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

# ---------------------------------------------------------------------------
# Enable and start Docker
# ---------------------------------------------------------------------------
log "Enabling and starting Docker service..."
systemctl enable docker
systemctl start docker

# ---------------------------------------------------------------------------
# griddog OS user
# ---------------------------------------------------------------------------
if id "${GRIDDOG_USER}" &>/dev/null; then
  log "User '${GRIDDOG_USER}' already exists, skipping creation."
else
  log "Creating OS user '${GRIDDOG_USER}'..."
  useradd --system --shell /bin/bash --create-home "${GRIDDOG_USER}"
fi

# Add griddog user to docker group so it can run docker without sudo
usermod -aG docker "${GRIDDOG_USER}"

# ---------------------------------------------------------------------------
# Application directory
# ---------------------------------------------------------------------------
log "Creating application directory ${GRIDDOG_DIR}..."
mkdir -p "${GRIDDOG_DIR}"
chown "${GRIDDOG_USER}:${GRIDDOG_USER}" "${GRIDDOG_DIR}"
chmod 750 "${GRIDDOG_DIR}"

# ---------------------------------------------------------------------------
# Clone or pull repository
# ---------------------------------------------------------------------------
if [[ -d "${GRIDDOG_DIR}/.git" ]]; then
  log "Repository already cloned; pulling latest changes on branch ${REPO_BRANCH}..."
  sudo -u "${GRIDDOG_USER}" git -C "${GRIDDOG_DIR}" fetch origin
  sudo -u "${GRIDDOG_USER}" git -C "${GRIDDOG_DIR}" checkout "${REPO_BRANCH}"
  sudo -u "${GRIDDOG_USER}" git -C "${GRIDDOG_DIR}" pull origin "${REPO_BRANCH}"
else
  log "Cloning repository from ${REPO_URL} (branch: ${REPO_BRANCH})..."
  sudo -u "${GRIDDOG_USER}" git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${GRIDDOG_DIR}"
fi

# ---------------------------------------------------------------------------
# UFW Firewall rules
# ---------------------------------------------------------------------------
log "Configuring UFW firewall rules..."
# Enable UFW non-interactively; allow SSH first to avoid lock-out
ufw --force enable
ufw allow 22/tcp    comment 'SSH'
ufw allow 3000/tcp  comment 'Next.js frontend'
ufw allow 8080/tcp  comment 'Go backend'
ufw allow 8081/tcp  comment 'Java service'
ufw allow 3001/tcp  comment 'Express service'
ufw reload

log "UFW status:"
ufw status verbose

log "setup-common.sh completed successfully."
