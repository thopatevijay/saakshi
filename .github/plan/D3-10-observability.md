---
title: "D3-10 · Observability: Prometheus metrics and Grafana health dashboard"
milestone: "Day 3 — Differentiators"
labels: ["day-3", "infra", "bonus"]
blocked_by: ["D1-05", "D1-09"]
estimate: "2h"
---

## Context

Bonus consideration explicitly lists *"operational dashboards, automated alerts, health monitoring,
or integration-ready APIs"*. At 80,000 cameras, **operability is the product** — a system nobody can
monitor is a system nobody runs.

## Scope

- Prometheus metrics from API and workers:
  - per-camera: connection state, measured fps, reconnect count, decode error count, trust score
  - pipeline: frames processed, inference calls, motion-gate skip ratio, ANPR reads/min,
    read confidence histogram, end-to-end latency (PTS → alert)
  - platform: request rate/latency/errors, bus lag, DB pool, MinIO write rate
- Grafana dashboards provisioned as code (JSON in repo, auto-loaded):
  `Estate Health` · `Pipeline Throughput` · `Alerting`
- Prometheus alert rules: camera down > 5 min · trust drop > 20 points · bus lag rising ·
  read rate collapse (a proxy for a silently broken pipeline)
- Both added to `docker-compose.yml` with provisioning mounted

## Acceptance Criteria

- [ ] `/metrics` exposed by API and workers with all listed metrics present and correctly labelled
- [ ] Prometheus scrapes both; targets healthy
- [ ] Three dashboards load automatically from provisioning on a fresh `docker compose up`
- [ ] End-to-end latency metric (PTS → alert) recorded and visible — this is a real number for the deck
- [ ] Alert rules fire in a test: kill a feed and observe `camera down` firing
- [ ] Dashboards render with real data from a live run, not empty panels
- [ ] Screenshot captured for the deck

## Deliverables

- `packages/api/src/metrics.ts`, `workers/*/metrics.py`
- `ops/grafana/dashboards/*.json`, `ops/prometheus/{prometheus.yml,rules.yml}`
- `docker-compose.yml` updated
- `docs/observability.md`

## Validation Gate

```bash
docker compose up -d prometheus grafana
curl -fsS localhost:4000/metrics | grep -c saakshi_
curl -fsS localhost:9090/api/v1/targets | jq '.data.activeTargets|map(.health)'
# kill a feed, then:
curl -fsS localhost:9090/api/v1/alerts | jq '.data.alerts|map(.labels.alertname)'
```

- [ ] All targets `up`; camera-down rule fires on a killed feed
- [ ] Dashboards populated; screenshot captured

## Handoff → D4-01

Metrics endpoints must survive the Railway deploy; confirm scrape config for the deployed topology.
