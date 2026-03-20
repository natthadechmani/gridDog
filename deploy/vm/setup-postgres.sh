#!/usr/bin/env bash
# setup-postgres.sh
# Install PostgreSQL 15 directly on the VM, create griddog user/database,
# configure pg_hba.conf for local-network access, and run init.sql.
# Run as root or with sudo: sudo bash setup-postgres.sh
set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
PG_VERSION="15"
DB_NAME="griddog"
DB_USER="griddog"
DB_PASSWORD="griddog"            # Change in production
ALLOW_NETWORK="10.0.0.0/8"      # Allow connections from this CIDR
GRIDDOG_DIR="/opt/griddog"
INIT_SQL="${GRIDDOG_DIR}/deploy/vm/init.sql"

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

log "Installing PostgreSQL ${PG_VERSION}..."
apt-get update -y
apt-get install -y gnupg curl lsb-release

# Add PostgreSQL PGDG repository
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
  | gpg --dearmor -o /etc/apt/keyrings/pgdg.gpg
chmod a+r /etc/apt/keyrings/pgdg.gpg

echo \
  "deb [signed-by=/etc/apt/keyrings/pgdg.gpg] https://apt.postgresql.org/pub/repos/apt \
  $(lsb_release -cs)-pgdg main" \
  > /etc/apt/sources.list.d/pgdg.list

apt-get update -y
apt-get install -y "postgresql-${PG_VERSION}"

# ---------------------------------------------------------------------------
# Start PostgreSQL
# ---------------------------------------------------------------------------
log "Enabling and starting PostgreSQL ${PG_VERSION} service..."
systemctl enable "postgresql@${PG_VERSION}-main"
systemctl start  "postgresql@${PG_VERSION}-main"

# Give the service a moment to fully start before we talk to it
sleep 2

# ---------------------------------------------------------------------------
# Create database user and database
# ---------------------------------------------------------------------------
log "Creating database user '${DB_USER}' and database '${DB_NAME}'..."

sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = '${DB_USER}') THEN
    CREATE ROLE ${DB_USER} LOGIN PASSWORD '${DB_PASSWORD}';
  ELSE
    ALTER ROLE ${DB_USER} WITH PASSWORD '${DB_PASSWORD}';
  END IF;
END
\$\$;

SELECT 'CREATE DATABASE ${DB_NAME} OWNER ${DB_USER}'
  WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = '${DB_NAME}')
\gexec
SQL

# ---------------------------------------------------------------------------
# Run init.sql if present
# ---------------------------------------------------------------------------
if [[ -f "${INIT_SQL}" ]]; then
  log "Running ${INIT_SQL}..."
  sudo -u postgres psql -d "${DB_NAME}" -v ON_ERROR_STOP=1 -f "${INIT_SQL}"
else
  log "No init.sql found at ${INIT_SQL}; skipping schema initialisation."
fi

# ---------------------------------------------------------------------------
# Configure pg_hba.conf
# ---------------------------------------------------------------------------
PG_HBA="/etc/postgresql/${PG_VERSION}/main/pg_hba.conf"
PG_CONF="/etc/postgresql/${PG_VERSION}/main/postgresql.conf"

log "Configuring pg_hba.conf at ${PG_HBA}..."

# Backup the original
cp "${PG_HBA}" "${PG_HBA}.bak.$(date +%s)"

# Remove any existing griddog rules to avoid duplicates on re-runs
grep -v "# griddog" "${PG_HBA}" > /tmp/pg_hba_clean.conf
mv /tmp/pg_hba_clean.conf "${PG_HBA}"

# Append rules: password auth for griddog user from local network and localhost
cat >> "${PG_HBA}" <<RULES

# griddog: allow password auth from local network
host    ${DB_NAME}    ${DB_USER}    127.0.0.1/32         md5   # griddog
host    ${DB_NAME}    ${DB_USER}    ::1/128               md5   # griddog
host    ${DB_NAME}    ${DB_USER}    ${ALLOW_NETWORK}      md5   # griddog
RULES

# ---------------------------------------------------------------------------
# Configure postgresql.conf to listen on all interfaces
# ---------------------------------------------------------------------------
log "Configuring postgresql.conf to listen on all interfaces..."

cp "${PG_CONF}" "${PG_CONF}.bak.$(date +%s)"

# Set listen_addresses if not already set to '*'
if grep -qE "^#?listen_addresses" "${PG_CONF}"; then
  sed -i "s|^#\?listen_addresses\s*=.*|listen_addresses = '*'|" "${PG_CONF}"
else
  echo "listen_addresses = '*'" >> "${PG_CONF}"
fi

# ---------------------------------------------------------------------------
# Reload PostgreSQL to apply configuration changes
# ---------------------------------------------------------------------------
log "Reloading PostgreSQL to apply changes..."
systemctl reload "postgresql@${PG_VERSION}-main"

# ---------------------------------------------------------------------------
# Verify connection
# ---------------------------------------------------------------------------
log "Verifying connection to database '${DB_NAME}' as user '${DB_USER}'..."
PGPASSWORD="${DB_PASSWORD}" psql \
  -h 127.0.0.1 \
  -U "${DB_USER}" \
  -d "${DB_NAME}" \
  -c "SELECT version();" && log "Connection successful."

log "setup-postgres.sh completed successfully."
