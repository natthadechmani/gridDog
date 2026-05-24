# Datadog config

Monitors and dashboards as JSON, paired with the runbooks in [deploy/vm/ansible/README.md](../vm/ansible/README.md).

## Layout

```
datadog/
├── monitors/
│   └── host-disk-usage.json     # Per-host root disk > 80/90% alert
└── dashboards/
    └── host-disk.json            # Disk investigation dashboard
```

## Apply

These are plain Datadog API payloads. Apply them via any of the methods below.

### Option 1 — UI (fastest, one-off)

**Monitor:** Datadog → Monitors → New Monitor → top-right `⋯` → Import → paste `monitors/host-disk-usage.json`.

**Dashboard:** Datadog → Dashboards → New Dashboard → top-right gear → Import Dashboard JSON → paste `dashboards/host-disk.json`.

### Option 2 — `datadog-ci` (scriptable)

```bash
brew install datadog-ci   # or: npm install -g @datadog/datadog-ci
export DATADOG_API_KEY=...
export DATADOG_APP_KEY=...

# Note: datadog-ci doesn't yet ship a generic monitor importer. Use the API directly:
curl -X POST "https://api.datadoghq.com/api/v1/monitor" \
  -H "DD-API-KEY: $DATADOG_API_KEY" \
  -H "DD-APPLICATION-KEY: $DATADOG_APP_KEY" \
  -H "Content-Type: application/json" \
  -d @deploy/datadog/monitors/host-disk-usage.json

curl -X POST "https://api.datadoghq.com/api/v1/dashboard" \
  -H "DD-API-KEY: $DATADOG_API_KEY" \
  -H "DD-APPLICATION-KEY: $DATADOG_APP_KEY" \
  -H "Content-Type: application/json" \
  -d @deploy/datadog/dashboards/host-disk.json
```

### Option 3 — Terraform (long-term, recommended)

Add the [`datadog/datadog`](https://registry.terraform.io/providers/DataDog/datadog/latest/docs) provider to your existing Terraform stack and reference these JSON files:

```hcl
resource "datadog_monitor_json" "host_disk_usage" {
  monitor = file("${path.module}/../../datadog/monitors/host-disk-usage.json")
}

resource "datadog_dashboard_json" "host_disk" {
  dashboard = file("${path.module}/../../datadog/dashboards/host-disk.json")
}
```

This is the recommended path long-term — changes to JSON are tracked in git, and `terraform plan` shows diffs before applying.

## Editing

After importing, if you tweak in the UI and want to bring changes back into git: open the dashboard/monitor in the UI, click `Export → JSON`, and overwrite the file here. Drift detection is then `git diff`.
