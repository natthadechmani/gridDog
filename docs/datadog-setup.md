# Datadog Setup Journal — GridDog

A step-by-step record of everything set up for Datadog monitoring on the GridDog stack.
Use this as a guidebook to reproduce, extend, or troubleshoot the setup.

**Stack:** 4 EC2s (nginx, frontend, app, databases) · Docker containers · Datadog Agent

---

## Step 1 — Deploy Datadog Agent (all hosts)

**Ansible playbook:** `deploy/ansible/playbooks/06_datadog.yml`
**Template:** `deploy/ansible/templates/docker-compose.datadog.yml.j2`

Runs `registry.datadoghq.com/agent:latest` in **host network mode** on all 4 EC2s.
`recreate: always` ensures the agent restarts on every playbook run to pick up config changes.

### Key environment variables (all hosts)

| Variable | Value |
|----------|-------|
| `DD_API_KEY` | from `group_vars/all.yml` → `dd_api_key` |
| `DD_ENV` | from `group_vars/all.yml` → `dd_env` |
| `DD_HOSTNAME` | `inventory_hostname` (Ansible) |
| `DD_LOGS_ENABLED` | `true` |
| `DD_LOGS_CONFIG_CONTAINER_COLLECT_ALL` | `true` |
| `DD_PROCESS_AGENT_ENABLED` | `true` |
| `DD_CONTAINER_EXCLUDE_LOGS` | `name:griddog-datadog` (exclude self) |
| `DD_TAGS` | `group:griddog` |

### Extra variables — databases host only (Jinja2 conditional)

```yaml
{% if inventory_hostname in groups['databases'] %}
- DD_LOGS_CONFIG_AUTO_MULTI_LINE_ENABLE_DATETIME_DETECTION=true
- DD_LOGS_CONFIG_AUTO_MULTI_LINE_ENABLE_JSON_DETECTION=true
{% endif %}
```

### Volume mounts — all hosts

```yaml
- /var/run/docker.sock:/var/run/docker.sock:ro
- /proc/:/host/proc/:ro
- /sys/fs/cgroup/:/host/sys/fs/cgroup:ro
- /var/lib/docker/containers:/var/lib/docker/containers:ro
- /opt/datadog-agent/run:/opt/datadog-agent/run:rw
```

### Extra volume — databases host only

```yaml
{% if inventory_hostname in groups['databases'] %}
- /var/log/postgresql:/var/log/postgresql:ro
{% endif %}
```

### Deploy command

```bash
cd deploy/ansible
ansible-playbook playbooks/06_datadog.yml
# or limit to one host:
ansible-playbook playbooks/06_datadog.yml --limit databases
```

---

## Step 2 — PostgreSQL Metrics Collection

Datadog discovers the postgres container via `com.datadoghq.ad.*` autodiscovery labels.

### Create the datadog user in PostgreSQL (one-time)

```bash
docker exec -it griddog-postgres psql -U griddog -d griddog
```

```sql
CREATE USER datadog WITH PASSWORD 'your-dd-postgres-password';
GRANT pg_monitor TO datadog;
```

### Autodiscovery labels on the postgres container

```yaml
com.datadoghq.ad.check_names: '["postgres"]'
com.datadoghq.ad.init_configs: '[{}]'
com.datadoghq.ad.instances: '[{"host":"%%host%%","port":5432,"username":"datadog","password":"{{ dd_postgres_password }}"}]'
```

Variable `dd_postgres_password` is set in `deploy/ansible/group_vars/all.yml`.

---

## Step 3 — PostgreSQL Log Collection (file-based)

### Why file-based, not container stdout?

Datadog's container log collection reads from Docker's log driver (stdout/stderr).
PostgreSQL writes structured logs via its own `logging_collector` — this goes to files inside the container, not stdout. The Datadog agent can't access files inside a container directly.

**Solution:** mount `/var/log/postgresql` as a host volume on both the postgres container and the Datadog agent container. The agent reads the log files from the host path.

### PostgreSQL logging configuration

Set via `command` flags in `deploy/ansible/templates/docker-compose.databases.yml.j2`:

```yaml
command: >
  postgres
  -c logging_collector=on
  -c log_directory=/var/log/postgresql
  -c log_filename=postgresql-%Y-%m-%d.log
  -c log_rotation_age=1440
  -c log_rotation_size=102400
  -c log_truncate_on_rotation=off
  -c log_statement=all
  -c log_line_prefix='%m [%p] %d [%a] %u %h %c '
  -c log_file_mode=0644
```

**Note on `log_line_prefix`:** The application name (`%a`) is wrapped in brackets `[%a]`.
This is intentional — see Step 4 for why.

### Host directory setup (Ansible)

The directory must exist with open permissions **before** the container starts.
If Docker creates it, it will be owned by root and PostgreSQL won't be able to write.

```yaml
# In deploy/ansible/playbooks/01_databases.yml
- name: Create postgres log directory
  ansible.builtin.file:
    path: /var/log/postgresql
    state: directory
    mode: "0777"
```

### Volume mounts

In `docker-compose.databases.yml.j2` (postgres container):
```yaml
volumes:
  - /var/log/postgresql:/var/log/postgresql
```

In `docker-compose.datadog.yml.j2` (Datadog agent, databases host only):
```yaml
- /var/log/postgresql:/var/log/postgresql:ro
```

### Autodiscovery log label with multi-line aggregation

```yaml
com.datadoghq.ad.logs: >
  [{"service":"griddog-postgresql","source":"postgresql","type":"file",
    "path":"/var/log/postgresql/postgresql-*.log",
    "log_processing_rules":[{
      "type":"multi_line",
      "name":"new_log_start_with_date",
      "pattern":"\\d{4}-\\d{2}-\\d{2} \\d{2}:\\d{2}:\\d{2}"
    }]}]
```

**Why multi-line?** PostgreSQL formats long SQL queries with newlines.
Without this rule, each line of a multi-line query appears as a separate log entry.
The pattern matches the timestamp at the start of each new log entry — anything that doesn't start with a timestamp is appended to the previous entry.

### Verify logs are being written

```bash
# SSH to databases host
ssh -J ubuntu@54.254.144.128 -i ~/.ssh/griddog-keypair.pem ubuntu@172.31.66.88

# Check log files exist
ls -la /var/log/postgresql/

# Tail the latest log file
tail -f /var/log/postgresql/postgresql-$(date +%Y-%m-%d).log
```

---

## Step 4 — PostgreSQL Custom Grok Parser (Datadog UI)

### Problem

The default Datadog PostgreSQL Grok parser uses `\S+` (no spaces) for the application name field.
When an app connects with a name containing spaces — e.g. `PostgreSQL JDBC Driver` — the parser fails and the log is not parsed into structured attributes.

**Unparsed log example:**
```
2026-04-04 17:55:31 UTC [33] griddog PostgreSQL JDBC Driver griddog 172.31.66.183 69d15062.21 LOG: execute S_3: BEGIN READ ONLY
```

### Fix — Part 1: Wrap `%a` in brackets in `log_line_prefix`

Changed from:
```
'%m [%p] %d %a %u %h %c '
```
To:
```
'%m [%p] %d [%a] %u %h %c '
```

Now the app name is unambiguous regardless of spaces:
```
2026-04-04 17:55:31 UTC [33] griddog [PostgreSQL JDBC Driver] griddog 172.31.66.183 69d15062.21 LOG: execute S_3: BEGIN READ ONLY
```

### Fix — Part 2: Add custom Grok rule in Datadog UI

**Location:** Logs → Configuration → Pipelines → postgresql (built-in) → Grok Parser → add rule

```
griddog_format %{_timestamp_ms} \[%{_proc_id}\] %{_database} \[%{data:application}\] %{_user} %{_client_ip} %{notSpace:session_id} %{_severity}:\s+(%{regex("statement:")} \s+%{_raw_query}|%{data:msg})
```

This rule uses the same helper macros as the other built-in rules (`%{_timestamp_ms}`, `%{_database}`, `%{_user}`, etc.) and adds `\[%{data:application}\]` to handle bracketed app names with spaces.

---

## Step 5 — MongoDB Metrics Collection

Datadog discovers the mongodb container via `com.datadoghq.ad.*` autodiscovery labels.

### Create the datadog user in MongoDB (one-time)

```bash
docker exec -it griddog-mongodb mongosh
```

```javascript
use admin
db.createUser({
  user: "datadog",
  pwd: "your-dd-mongo-password",
  roles: [
    { role: "clusterMonitor", db: "admin" },
    { role: "read", db: "local" }
  ]
})
```

### Autodiscovery labels on the mongodb container

```yaml
com.datadoghq.ad.check_names: '["mongo"]'
com.datadoghq.ad.init_configs: '[{}]'
com.datadoghq.ad.instances: >
  [{"hosts":["%%host%%:27017"],
    "username":"datadog",
    "password":"{{ dd_mongo_password }}",
    "database":"admin",
    "database_autodiscovery":{"enabled":true}}]
```

`database_autodiscovery` automatically collects metrics from all databases (griddog, admin, local, config) without listing them explicitly.

Variable `dd_mongo_password` is set in `deploy/ansible/group_vars/all.yml`.

---

## Step 6 — MongoDB Operation Logging

### Problem

MongoDB 7 logs operations that exceed a threshold. The default threshold is **100ms** — fast queries are invisible.

### Fix

Start `mongod` with `--slowms 0` to log **all** operations regardless of duration.

In `deploy/ansible/templates/docker-compose.databases.yml.j2`:

```yaml
command: mongod --slowms 0
```

### MongoDB 7 log format

MongoDB 7 uses **JSON-structured logs** (unlike the text format in 2.x/3.x/4.x).
Datadog auto-parses the JSON. Key fields in a slow query log entry:

```json
{
  "t": {"$date": "2026-04-04T17:34:21.656+00:00"},
  "s": "I",
  "c": "COMMAND",
  "msg": "Slow query",
  "attr": {
    "ns": "griddog.shop_items",
    "planSummary": "COLLSCAN",
    "durationMillis": 0,
    "nreturned": 6,
    "docsExamined": 6,
    "command": { "find": "shop_items", ... }
  }
}
```

### Tail MongoDB logs

```bash
docker logs griddog-mongodb -f 2>&1 | grep -i slow
```

---

## Step 7 — MongoDB Log Pipeline (Datadog UI)

### Problem

Every slow query log shows the same generic message: **"Slow query"**.
There is no context about which collection was queried, how long it took, or what the query plan was.

### Why `%{msg}` doesn't work in pipelines

The `msg` field is listed in **Preprocessing for JSON logs → Message attributes** (`message, msg, log`).
This means Datadog promotes `msg` to the official log message **before** any pipeline runs — consuming it as an attribute. It cannot be referenced as `%{msg}` in pipeline processors.

### Solution — Custom pipeline in Datadog UI

**Location:** Logs → Configuration → Pipelines → New Pipeline
**Filter:** `source:mongodb`

#### Processor 1: String Builder

| Setting | Value |
|---------|-------|
| Template | `[%{attr.durationMillis}ms] %{attr.ns} — Slow query \| plan:%{attr.planSummary} returned:%{attr.nreturned} examined:%{attr.docsExamined}` |
| Target attribute | `formatted_message` |
| Replace missing attribute | enabled |

Uses `attr.*` fields directly from the auto-parsed MongoDB JSON — no Attribute Remapper needed.

#### Processor 2: Log Message Remapper

| Setting | Value |
|---------|-------|
| Attribute | `formatted_message` |

### Result

Log message changes from:
```
Slow query
```
To:
```
[0ms] griddog.shop_items — Slow query | plan:COLLSCAN returned:6 examined:6
```

### Verify in Datadog

Filter: `source:mongodb service:griddog-mongodb`

---

## Key Lessons Learned

| Issue | Root Cause | Fix |
|-------|-----------|-----|
| PostgreSQL won't write logs | Docker created `/var/log/postgresql` as root | Pre-create directory with `mode: 0777` in Ansible before container starts |
| Datadog agent can't collect postgres logs | Log files are inside the container, not on host | Mount `/var/log/postgresql` as host volume on both postgres and Datadog agent containers |
| Multi-line SQL queries split into separate log entries | Each line treated as a new log entry | Add `log_processing_rules` with `multi_line` pattern in autodiscovery label |
| JDBC Driver logs not parsed by Grok | App name `PostgreSQL JDBC Driver` has spaces; Grok uses `\S+` | Wrap `%a` in brackets in `log_line_prefix`, add custom Grok rule |
| `%{msg}` empty in MongoDB pipeline | Preprocessing promotes `msg` to official message before pipelines run | Hardcode "Slow query" in String Builder (it's always this value for slow ops) |
| MongoDB existing Grok rules don't match v7 logs | v7 uses JSON; existing rules target text-format logs (2.x/3.x/4.x) | Use JSON field references (`attr.*`) directly in pipeline processors |
