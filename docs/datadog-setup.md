# Datadog Setup Journal — GridDog

A step-by-step record of everything set up for Datadog monitoring on the GridDog stack.
Use this as a guidebook to reproduce, extend, or troubleshoot the setup.

**Stack:** 4 EC2s (nginx, frontend, app, databases) · Docker containers · Datadog Agent

---

## Step 1 — Deploy Datadog Agent (all hosts)

**Ansible playbook:** `deploy/vm/ansible/playbooks/06_datadog.yml`
**Template:** `deploy/vm/ansible/templates/docker-compose.datadog.yml.j2`

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
cd deploy/vm/ansible
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

Variable `dd_postgres_password` is set in `deploy/vm/ansible/group_vars/all.yml`.

---

## Step 3 — PostgreSQL Log Collection (file-based)

### Why file-based, not container stdout?

Datadog's container log collection reads from Docker's log driver (stdout/stderr).
PostgreSQL writes structured logs via its own `logging_collector` — this goes to files inside the container, not stdout. The Datadog agent can't access files inside a container directly.

**Solution:** mount `/var/log/postgresql` as a host volume on both the postgres container and the Datadog agent container. The agent reads the log files from the host path.

### PostgreSQL logging configuration

Set via `command` flags in `deploy/vm/ansible/templates/docker-compose.databases.yml.j2`:

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
# In deploy/vm/ansible/playbooks/01_databases.yml
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

Variable `dd_mongo_password` is set in `deploy/vm/ansible/group_vars/all.yml`.

---

## Step 6 — MongoDB Operation Logging

### Problem

MongoDB 7 logs operations that exceed a threshold. The default threshold is **100ms** — fast queries are invisible.

### Fix

Start `mongod` with `--slowms 0` to log **all** operations regardless of duration.

In `deploy/vm/ansible/templates/docker-compose.databases.yml.j2`:

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

---

## Step 8 — APM / Distributed Tracing: Agent Setup

APM requires three settings on the Datadog agent (already set in
`deploy/vm/ansible/templates/docker-compose.datadog.yml.j2`):

| Variable | Value | Why |
|----------|-------|-----|
| `DD_APM_ENABLED` | `true` | Activates the trace intake endpoint |
| `DD_APM_NON_LOCAL_TRAFFIC` | `true` | Accepts traces from other containers (not just localhost) |
| `DD_DOGSTATSD_NON_LOCAL_TRAFFIC` | `true` | Same for metrics/DogStatsD |

### Network requirement on the app host

On the app EC2, all four services run on the `griddog_network` Docker bridge. The Datadog
agent must join the same bridge so app containers can reach it by the hostname `datadog-agent`.

In `docker-compose.datadog.yml.j2`, a Jinja2 conditional adds the agent to the bridge on the
app host only:

```yaml
{% if inventory_hostname in groups['app'] %}
    networks:
      - griddog-network
    ports:
      - "8126:8126/tcp"
      - "8125:8125/udp"
{% else %}
    network_mode: host
{% endif %}
```

On all other hosts (nginx, frontend, databases) the agent uses `network_mode: host` instead.

Every app service sets `DD_AGENT_HOST: datadog-agent` — the tracer resolves this to the
agent container on the shared bridge.

---

## Step 9 — Unified Service Tagging

Every service uses the same three-variable + three-label pattern so Datadog can correlate
traces, logs, and metrics under the same service identity.

**Environment variables** (set on the container):

```yaml
DD_SERVICE: "go-backend-vm"
DD_ENV: "{{ dd_env }}"
DD_VERSION: "1.0.1"
```

**Docker labels** (read by the Datadog agent):

```yaml
com.datadoghq.tags.service: "go-backend-vm"
com.datadoghq.tags.env: "{{ dd_env }}"
com.datadoghq.tags.version: "1.0.1"
```

**Team tag** (custom label mapped to a Datadog tag via `DD_CONTAINER_LABELS_AS_TAGS`):

```yaml
my.custom.label.team: 'golang-backend-team'
```

The agent config `DD_CONTAINER_LABELS_AS_TAGS={"my.custom.label.team":"team"}` maps this
label to the `team` tag on every metric and log emitted from that container.

### Service name reference

| Service | `DD_SERVICE` | `DD_VERSION` |
|---------|-------------|-------------|
| Go backend | `go-backend-vm` | `1.0.1` |
| Java service | `java-backend-vm` | `2.0.1` |
| Express service | `express-service-vm` | `3.0.1` |
| .NET scheduler | `dotnet-scheduler-vm` | `1.0.0` |

---

## Step 10 — Go Backend: Orchestrion (compile-time instrumentation)

**How it works:** Orchestrion rewrites Go source code at compile time to inject tracing calls.
The tracer is baked into the binary — no imports, no code changes, no runtime dependency.
`orchestrion go build` is a drop-in replacement for `go build`.

**Dockerfile** (`backend/Dockerfile`):

```dockerfile
RUN go install github.com/DataDog/orchestrion@latest
RUN GOARCH=amd64 orchestrion go build -o /app/server .
```

**docker-compose env vars** (`deploy/vm/ansible/templates/docker-compose.app.yml.j2`):

```yaml
DD_SERVICE: "go-backend-vm"
DD_VERSION: "1.0.1"
DD_ENV: "{{ dd_env }}"
DD_AGENT_HOST: datadog-agent
DD_LOGS_INJECTION: "true"
DD_RUNTIME_METRICS_ENABLED: "true"
DD_PROFILING_ENABLED: "true"
DD_TRACE_SAMPLING_RULES: '[{"service": "go-backend-vm", "sample_rate": 1.0}]'
```

`DD_TRACE_SAMPLING_RULES` is a tracer-side env var (not agent-side). `sample_rate: 1.0` = 100%
head-based sampling — every request produces a complete trace. Appropriate for sandbox/demo
where full fidelity matters more than cost.

---

## Step 11 — Java Service: -javaagent instrumentation

**How it works:** The Datadog Java agent attaches to the JVM via `-javaagent` and uses the
JVM Instrumentation API to rewrite bytecode at class-load time. It wraps HTTP clients, JDBC
calls, and other libraries automatically — no source code changes needed.

**Dockerfile** (`java-service/Dockerfile`):

```dockerfile
# Build stage — download the agent alongside the app JAR
RUN curl -Lo dd-java-agent.jar 'https://dtdg.co/latest-java-tracer'

# Runtime stage — agent is passed to the JVM at startup
ENTRYPOINT ["java", "-javaagent:dd-java-agent.jar", "-jar", "app.jar"]
```

**docker-compose env vars** (`deploy/vm/ansible/templates/docker-compose.app.yml.j2`):

```yaml
DD_SERVICE: "java-backend-vm"
DD_VERSION: "2.0.1"
DD_ENV: "{{ dd_env }}"
DD_AGENT_HOST: datadog-agent
DD_LOGS_INJECTION: "true"
DD_RUNTIME_METRICS_ENABLED: "true"
DD_PROFILING_ENABLED: "true"
```

**Autodiscovery log label** (tells agent what log source to apply):

```yaml
com.datadoghq.ad.logs: '[{"source": "java"}]'
```

### Diagnostic — if traces don't appear

```bash
docker exec griddog-java-service java -jar /app/dd-java-agent.jar sampleTrace -c 1
```

Look for `"agent_error":false` and `"agent_url":"http://datadog-agent:8126"`.
If `agent_error` is true, `DD_AGENT_HOST` is likely missing or wrong.

---

## Step 12 — Express (Node.js): dd-trace monkey-patching

**How it works:** `dd-trace` hooks into Node.js's module registry at process startup. When the
app calls `require('express')` or `require('mongodb')`, the tracer intercepts the call and
wraps those modules to emit spans. This technique — replacing functions on live objects at
runtime — is called monkey-patching. No app code changes are needed.

**Dockerfile** (`express-service/Dockerfile`):

```dockerfile
RUN npm install --omit=dev
RUN npm install dd-trace          # installed as a separate layer for cache efficiency

ENV NODE_OPTIONS="--require dd-trace/init"
```

`NODE_OPTIONS="--require dd-trace/init"` loads the tracer before any application code runs.
It is equivalent to adding `require('dd-trace').init()` as the first line of the app entry
point — without modifying any source files.

**docker-compose env vars** (`deploy/vm/ansible/templates/docker-compose.app.yml.j2`):

```yaml
DD_SERVICE: "express-service-vm"
DD_VERSION: "3.0.1"
DD_ENV: "{{ dd_env }}"
DD_AGENT_HOST: datadog-agent
DD_LOGS_INJECTION: "true"
DD_RUNTIME_METRICS_ENABLED: "true"
DD_PROFILING_ENABLED: "true"
```

### Reference Dockerfiles

| File | Framework | Key difference |
|------|-----------|----------------|
| `express-service/dockerfile-example` | Express | Minimal single-stage, no user/group |
| `express-service/dockerfile-mock-nextjs` | Next.js | `npm run build` + `CMD ["npm", "start"]` |
| `express-service/dockerfile-mock-nestjs` | NestJS | TypeScript compile → `CMD ["node", "dist/main"]` |

---

## Step 13 — .NET Scheduler: CLR Profiler API

**How it works:** .NET tracing uses the CLR Profiling API — a native C++ interface the .NET
runtime exposes for inspection tools. Unlike Java (`-javaagent`) or Node.js (`--require`),
the .NET profiler is a native shared library (`.so`) that must be installed inside the
container. Four environment variables tell the CLR to load it at process start.

### Installation

`aspnet:8.0` is a Debian Bookworm image, so the `.deb` package is used:

```dockerfile
RUN apt-get update && apt-get install -y curl && rm -rf /var/lib/apt/lists/* \
    && curl -Lo /tmp/datadog-dotnet-apm.deb \
       https://github.com/DataDog/dd-trace-dotnet/releases/download/v3.14.0/datadog-dotnet-apm_3.14.0_amd64.deb \
    && dpkg -i /tmp/datadog-dotnet-apm.deb \
    && rm /tmp/datadog-dotnet-apm.deb \
    && /opt/datadog/createLogPath.sh
```

**Why `.deb` not `.tar.gz`:** `createLogPath.sh` uses `set -o pipefail` (bash syntax). Running
it via `sh` (which is `dash` on Debian) fails with `"Illegal option -o pipefail"`. The `.deb`
installer handles this correctly — it runs the script under `bash` internally.

### CLR activation env vars (set in Dockerfile)

```dockerfile
ENV CORECLR_ENABLE_PROFILING=1
ENV CORECLR_PROFILER={846F5F1C-F9AE-4B07-969E-05C26BC060D8}
ENV CORECLR_PROFILER_PATH=/opt/datadog/Datadog.Trace.ClrProfiler.Native.so
ENV DD_DOTNET_TRACER_HOME=/opt/datadog
ENV LD_PRELOAD=/opt/datadog/continuousprofiler/Datadog.Linux.ApiWrapper.x64.so
```

| Variable | Purpose |
|----------|---------|
| `CORECLR_ENABLE_PROFILING` | Tells the CLR to activate profiler mode |
| `CORECLR_PROFILER` | Fixed GUID that identifies the Datadog profiler to the CLR |
| `CORECLR_PROFILER_PATH` | Absolute path to the native `.so` profiler library |
| `DD_DOTNET_TRACER_HOME` | Directory where the tracer's managed assemblies live |
| `LD_PRELOAD` | Loads the Linux API wrapper for CPU/wall time profiling (see Step 14) |

These are set as `ENV` in the Dockerfile (not docker-compose) because they point to paths
that only exist inside the image — they are image facts, not runtime configuration.

**docker-compose env vars** (`deploy/vm/ansible/templates/docker-compose.app.yml.j2`):

```yaml
DD_SERVICE: "dotnet-scheduler-vm"
DD_VERSION: "1.0.0"
DD_ENV: "{{ dd_env }}"
DD_AGENT_HOST: datadog-agent
DD_LOGS_INJECTION: "true"
DD_RUNTIME_METRICS_ENABLED: "true"
DD_PROFILING_ENABLED: "true"
```

---

## Step 14 — .NET Continuous Profiling

The Datadog .NET tracer package (v2.8.0+) ships the continuous profiler binary alongside the
APM tracer — no separate installation is needed.

Two things are required:

1. **`LD_PRELOAD`** (Dockerfile) — loads `Datadog.Linux.ApiWrapper.x64.so`, which wraps Linux
   syscalls to enable CPU time and wall time sampling. Without it, the profiler can't measure
   time accurately on Linux.

2. **`DD_PROFILING_ENABLED: "true"`** (docker-compose) — runtime on/off toggle. Set in
   docker-compose (not Dockerfile) because it can vary per environment.

### Verify

```bash
docker logs griddog-dotnet-scheduler | grep -i profil
```

Look for lines like `Datadog Continuous Profiler initialized`. After 60 seconds, profiles
should appear in Datadog → Continuous Profiler → service: `dotnet-scheduler-vm`.

---

## Step 15 — Log Injection (Trace Correlation)

`DD_LOGS_INJECTION: "true"` instructs the tracer to automatically inject `dd.trace_id` and
`dd.span_id` into every structured log entry. Datadog uses these IDs to link a log line to
the exact trace that produced it (visible in the "Logs" tab of any trace in APM).

All four services use JSON-format loggers:

| Service | Logger |
|---------|--------|
| Go backend | `log/slog` |
| Java service | Logback + LogstashEncoder |
| Express service | Winston |
| .NET scheduler | `Microsoft.Extensions.Logging` (JSON console) |

JSON logging is required — text-format logs don't support field injection.

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
| Java traces not appearing in Datadog | `DD_AGENT_HOST` missing — tracer defaults to `localhost:8126`, can't reach agent container | Add `DD_AGENT_HOST: datadog-agent` to every app service |
| `.tar.gz` `.NET` install: `createLogPath.sh` fails | Script uses bash syntax (`set -o pipefail`); Debian's `sh` is `dash`, not `bash` | Use `.deb` installer on Debian-based images (`aspnet:8.0` is Debian Bookworm) |
| .NET profiler shows no CPU/wall time data | `LD_PRELOAD` missing — Linux API wrapper not loaded | Add `ENV LD_PRELOAD=/opt/datadog/continuousprofiler/Datadog.Linux.ApiWrapper.x64.so` to Dockerfile |
| Datadog service map shows "blocked-ip-address" node | Raw IP addresses in `peer.hostname` are redacted by Datadog | Use DNS hostnames (e.g. AWS internal DNS) instead of raw IPs in service-to-service URLs |
