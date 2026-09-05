# Observability

At 80,000 cameras **operability is the product**. A federation layer nobody can monitor is a
federation layer nobody will run, and the challenge's bonus criteria say so out loud: *"operational
dashboards, automated alerts, health monitoring, or integration-ready APIs"*.

This document is the contract for that layer: what is exported, what each number means, what it
deliberately does **not** mean, and how to run the whole thing.

---

## 1. Run it

```bash
make up                                  # db · valkey · minio · mediamtx
docker compose up -d prometheus grafana  # :9090 and :3001

npm run dev -w @saakshi/api                                     # /metrics on :4000
npm run consume:sightings -- --metrics-port 9464                # /metrics on :9464
python -m workers.analytics.run --cameras cam01 cam02 \
       --minutes 30 --metrics-port 9465                         # /metrics on :9465
python -m workers.prober.run --all --interval 900 --metrics-port 9466
```

Grafana is on **`http://localhost:3001`** (`3000` is `next dev`; override with
`GRAFANA_HOST_PORT`). Anonymous viewing is on, so a demo is one click; `admin` / `saakshi` is needed
to change anything, and the dashboard provider sets `allowUiUpdates: false` so a browser edit could
not be saved anyway. **Dashboards are files in this repo.** Edit
`ops/grafana/dashboards/*.json` and Grafana reloads within ten seconds.

| Piece | Where | Why there |
|---|---|---|
| Scrape config | `ops/prometheus/prometheus.yml` | |
| Alert rules | `ops/prometheus/rules.yml` | every threshold cites the measurement it came from |
| Datasource | `ops/grafana/provisioning/datasources/prometheus.yml` | fixed `uid`, so committed panels resolve |
| Dashboard provider | `ops/grafana/provisioning/dashboards/saakshi.yml` | |
| Dashboards | `ops/grafana/dashboards/{estate-health,pipeline-throughput,alerting}.json` | |
| API exporter | `packages/api/src/metrics.ts`, wired by `packages/api/src/routes/metrics.ts` | |
| Worker exporters | `workers/analytics/metrics.py`, `workers/prober/metrics.py` | |

### Why the API and the workers are not compose services

They are the code under development. Containerising them would mean an image rebuild per edit,
which is the wrong trade for a stack a developer runs all day. Prometheus reaches them on
`host.docker.internal`; `extra_hosts: ['host.docker.internal:host-gateway']` gives Linux the name
Docker Desktop already provides.

### A worker that is not running scrapes DOWN, and that is correct

`saakshi-analytics` and `saakshi-prober` are **batch** processes. `up == 0` on those normally means
"no run in flight", not "the worker crashed". Only `SaakshiComponentDown` on the API treats a failed
scrape as a fault; the Estate Health board shows the worker jobs as an up/down strip instead.

---

## 2. The three semantics that are easy to get wrong

These are not style preferences. Each is a correction to a mistake this project measured.

### 2.1 A null is never a zero

`measured_fps IS NULL` means **could not measure**. D1-05 recorded the same camera as unmeasurable
after a 516,783 ms probe and at 20 fps after an 85,536 ms one — same code, same camera, different
network. A metric that exported the first as `0` would condemn a camera for the gateway's behaviour.

So an unmeasurable rate publishes **no `measured_fps` sample at all**, and a companion marker says
why:

```
saakshi_camera_fps_unmeasurable{camera="cam12",reason="too_slow_to_measure"} 1
```

`reason` comes from `breakdown.fps.unmeasurable_reason`, written by the prober. Nothing invents one.

The same shape applies to trust. A camera that has never been scored gets
`saakshi_camera_unbanded{camera=…} 1` and **no** `saakshi_camera_trust_band` series — "never probed"
is not a low score, and the Estate Health board counts `unscored` as its own band.

The same shape applies to a *stale* value: when a camera that measured 25 fps becomes unmeasurable,
the exporter **removes** the old sample rather than leaving it standing. A stale sample is worse
than an absent one, because a stale one looks healthy.

### 2.2 `pts_drift_ms` means two different things

- **live source** → encoder clock drift. Worth alerting on: a camera whose clock is wrong silently
  corrupts every route reconstruction it contributes to (D3-01, D3-02).
- **VOD source** → pull-rate skew. Means nothing. On the Sentinel sandbox the median is
  **124,007 ms**, and **every sandbox row is VOD**.

The gauge therefore carries the meaning as a label, taken from `breakdown.pts_drift_meaning`:

```
saakshi_camera_pts_drift_ms{camera="cam01",meaning="vod"}  124007
saakshi_camera_pts_drift_ms{camera="cam99",meaning="live"} 42
```

`SaakshiEncoderClockDrift` selects `meaning="live"` only. An alert on raw drift would fire on all 30
sandbox cameras, all the time, and truthfully mean nothing.

### 2.3 Read rate is judged against the camera's own baseline

Over one 22-minute soak, in one city at one hour:

| camera | sightings | note |
|---|---|---|
| cam04 | 33,548 | |
| cam08 | 24,462 | |
| … | | |
| **cam03** | **67** | decoded 5,582 frames cleanly at 23.16 fps — **not broken**, it just sees almost no vehicles |

A **500×** spread. Any estate-wide read-rate floor either pages somebody every night about cam03 or
never notices cam04 falling to a tenth of itself. So the exporter publishes both the current rate
and the camera's own 24-hour median, and `SaakshiReadRateCollapse` compares one to the other:

```
saakshi_camera_sightings_per_min{camera="cam04"}
saakshi_camera_sightings_baseline_per_min{camera="cam04"}
```

> **At estate scale the baseline belongs in a Timescale continuous aggregate.** The current query is
> a `percentile_cont` over 24 hours of `sightings`, refreshed every 5 minutes. That is fine for 30
> cameras and wrong for 80,000. Logged to BL-01.

---

## 3. The panel that matters most: declared vs measured vs effective

Three different frame rates. Confusing any two produces a false capacity claim.

| | what it is | source |
|---|---|---|
| **declared** | what the camera or its container *claims* | the stream header; `cameras.declared_fps` when the catalogue supplies one — on this estate it does not, so the header is the only source |
| **measured** | what the stream actually *carries*, counted from PTS with the connect burst discarded | prober and analytics worker |
| **effective** | what we actually *receive*, frames per **wall** second | analytics worker |

Measured against the government sandbox:

- `cam01` **declares 30**, **carries 14.99**, **delivers 4.00**.
- Across eight cameras: measured fps **15–30**, effective fps **1.92–4.00**.
- The same 1.3 KB catalogue fetch took **4.2 s** and, under load, **63 s** (D1-03).
- A 6-second HLS segment arrived in **22–49 s** (D3-07).

**The gateway throttles roughly tenfold.** Any capacity claim about the department feed must use the
effective column; any claim about our hardware must use a local MediaMTX run, where the same
pipeline sustained **199.78 aggregate fps** across eight cameras.

### Starvation is a ratio, not a latency

A slow gateway looks exactly like a broken worker, and one latency number cannot tell them apart.
D1-09 measured **2302.9 s blocked upstream against 150.1 s of our own loop** over a 22-minute soak —
**with zero reconnects** — and individual stalls of **54.6 s** between frames on healthy cameras.

So the worker exports the two counters separately and the dashboard divides:

```promql
rate(saakshi_worker_camera_upstream_wait_seconds_total[5m])
/ ( rate(saakshi_worker_camera_upstream_wait_seconds_total[5m])
  + rate(saakshi_worker_camera_loop_self_seconds_total[5m]) )
```

Above roughly 0.7 there is nothing to fix in this pipeline. That is also why `SaakshiCameraDown` is
built on the worker's **session flag** rather than on a frame rate, and why `SaakshiCameraStarved`
sits at 120 s — more than twice the worst observed healthy stall.

> D1-09's handoff reports the headline as "92% upstream-bound"; recomputed from its own two published
> totals it is 93.9%. The exporter publishes raw seconds and lets the dashboard divide, so a reader
> can always reproduce the figure rather than inherit somebody's rounding.

---

## 4. End to end: PTS → alert

The number the deck quotes. It is measured from the sighting's **PTS-derived** timestamp — the
frame's own presentation time plus the stream epoch, *never* frame arrival time — to the moment
watchlist correlation raised an alert for it.

Two series measure the same quantity from two places, because each covers the other's blind spot:

| metric | where | survives the consumer exiting? |
|---|---|---|
| `saakshi_pts_to_alert_latency_seconds` (histogram) | sightings consumer, observed per alert raised | no |
| `saakshi_alert_pts_latency_seconds{quantile}` (gauge) | API, from `alerts.created_at - alerts.sighting_ts` over 24 h | yes |

`saakshi_pts_to_ingest_latency_seconds` is the first half of the same journey — frame time to the
row being committed. The gap between the two is what correlation costs.

**Read it next to the starvation panel before quoting it as a system latency.** On a throttled
gateway most of the wall time is the gateway.

---

## 5. Uptime, honestly

`PROJECT.md` states a target of **> 99%**. This layer does not restate the target; it measures what
we observed and puts the two side by side:

```promql
avg_over_time(up{job="saakshi-api"}[$__range]) * 100   # observed, over the dashboard's own range
saakshi_uptime_target_ratio * 100                      # the stated target, a constant
```

The observed figure is only as meaningful as its window: over a ten-minute range, one missed scrape
is 2.5%. The Estate Health board states the window on the panel, and **if the observed number is
below the target the panel says so.** A dashboard that could only ever show 99% would not be a
measurement.

`saakshi_estate_camera_uptime_ratio` is a different question: the fraction of *probed* cameras whose
newest health check was connectable. That is a property of the department's estate and its network,
not of this software, and a camera that has never been probed is in neither number.

---

## 6. Metric reference

Every series is prefixed `saakshi_`. Node runtime metrics from the API carry `saakshi_api_node_`, so
a default metric is never mistaken for a domain measurement.

### API — `:4000/metrics`

| metric | type | notes |
|---|---|---|
| `saakshi_api_http_requests_total{method,route,status}` | counter | `route` is the **template**, never the resolved URL — one series per camera would take the monitoring down |
| `saakshi_api_http_request_duration_seconds{method,route}` | histogram | bucket edge at exactly `0.2` — the stated latency target is read off the data, not interpolated |
| `saakshi_api_http_errors_total{method,route,class}` | counter | `class` is `4xx` or `5xx` |
| `saakshi_db_reachable`, `saakshi_db_pool_max`, `saakshi_db_backends{state}` | gauge | backends measured **server-side** from `pg_stat_activity`: the number that exhausts `max_connections` is the server's, not the client pool's |
| `saakshi_bus_reachable` | gauge | |
| `saakshi_bus_stream_length{stream}` | gauge | |
| `saakshi_bus_group_lag_entries{stream,group}` | gauge | rises when **nothing** is draining |
| `saakshi_bus_group_pending_entries{stream,group}` | gauge | rises when something is attached but **stuck** |
| `saakshi_bus_group_consumers{stream,group}` | gauge | |
| `saakshi_camera_declared_fps{camera}` | gauge | |
| `saakshi_camera_measured_fps{camera}` | gauge | **absent** when unmeasurable |
| `saakshi_camera_fps_unmeasurable{camera,reason}` | gauge | the marker for the above |
| `saakshi_camera_trust_score{camera}` | gauge | absent when never scored |
| `saakshi_camera_trust_band{camera,band}` | gauge | absent when never scored |
| `saakshi_camera_unbanded{camera}` | gauge | the marker for the above |
| `saakshi_camera_connectable{camera}`, `saakshi_camera_decodable{camera}` | gauge | absent when never probed |
| `saakshi_camera_pts_drift_ms{camera,meaning}` | gauge | `meaning` is load-bearing — see §2.2 |
| `saakshi_camera_blur_score{camera}` | gauge | spans five orders of magnitude (0.011 – 5794) — never scale it linearly beside anything |
| `saakshi_camera_luma_mean{camera}`, `saakshi_camera_tamper_score{camera}` | gauge | |
| `saakshi_camera_health_age_seconds{camera}` | gauge | a full sweep is 23.6 min, so a healthy estate legitimately spans that |
| `saakshi_camera_status{camera,status}` | gauge | registry health — **independent** of `catalogue_status`, which is presence |
| `saakshi_camera_sightings_per_min{camera}` | gauge | last 5 minutes |
| `saakshi_camera_sightings_baseline_per_min{camera}` | gauge | the camera's own 24 h median — see §2.3 |
| `saakshi_camera_sightings_stored{camera}` | gauge | monotonic; use `deriv()` |
| `saakshi_estate_cameras{catalogue_status}` | gauge | |
| `saakshi_estate_cameras_by_band{band}` | gauge | `unscored` is its own band |
| `saakshi_estate_camera_uptime_ratio` | gauge | |
| `saakshi_plate_reads_stored`, `saakshi_plate_reads_per_min` | gauge | ANPR is the only mandatory analytic |
| `saakshi_alerts_stored{status,severity}` | gauge | |
| `saakshi_alert_pts_latency_seconds{quantile}` | gauge | `p50` / `p95` / `max` |
| `saakshi_evidence_objects_stored{kind}` | gauge | `deriv()` is the object-store write rate |
| `saakshi_audit_chain_entries`, `saakshi_audit_chain_forks` | gauge | forks > 0 has no acceptable value |
| `saakshi_relay_*` | gauge | D3-07's own counters, exported rather than re-instrumented |
| `saakshi_uptime_target_ratio` | gauge | the stated target, as a constant |

### Sightings consumer — `:9464/metrics`

`saakshi_consumer_entries_read_total` · `_sightings_inserted_total` · `_plate_reads_inserted_total` ·
`_invalid_payloads_total` · `_unknown_cameras_total` · `_alerts_raised_total` ·
`_correlation_failures_total` · `saakshi_pts_to_ingest_latency_seconds` ·
`saakshi_pts_to_alert_latency_seconds` · `saakshi_plate_read_confidence`.

`saakshi_plate_read_confidence` is a **distribution, not an accuracy claim**. Confidence is what the
OCR reports about itself; measured precision and recall — including where they fail, at night, on
two-wheelers and at oblique angles — are in `docs/anpr-accuracy.md`.

### Analytics worker — `:9465/metrics`

Per camera: `saakshi_worker_camera_connected` · `_seconds_since_frame` · `_declared_fps` ·
`_measured_fps` · `_fps_unmeasurable{reason}` · `_effective_fps` · `_motion_gate_skip_ratio` ·
`_max_interframe_gap_seconds` · `_tracking_sessions` · `_info{resolution,codec,imgsz}` ·
`_frames_decoded_total` · `_frames_considered_total` · `_inferences_total` · `_detections_total` ·
`_sightings_published_total` · `_plate_reads_published_total` · `_reconnects_total` ·
`_decode_errors_total{retryable}` · `_decoder_warnings_total{kind}` · `_scene_cuts_total` ·
`_upstream_wait_seconds_total` · `_loop_self_seconds_total`.

Run-level: `saakshi_worker_cameras_connected` · `saakshi_worker_uptime_seconds` ·
`saakshi_worker_inference_calls_total` · `saakshi_worker_inference_latency_ms{quantile}`.

It is a **scrape-time collector** over live `CameraStats`, not a set of gauges the decode loop
updates. Eight threads at tens of frames a second each would otherwise pay for a lock and a label
lookup per frame to produce a number nobody reads more often than every fifteen seconds.

### Trust prober — `:9466/metrics`

`saakshi_prober_camera_connectable` · `_decodable` · `_measured_fps` · `_declared_fps` ·
`_fps_diverged` · `_fps_unmeasurable{reason}` · `_blur_score` · `_luma_mean` · `_night_usable` ·
`_tamper_score` · `_pts_drift_ms{meaning}` · `_probe_ms` · `_probe_failed{retryable}` ·
`saakshi_prober_results_total{outcome}` · `_pass_duration_seconds` · `_pass_cameras`.

Updated **per result**, inside the sweep, not after it — a sweep takes 23.6 minutes at pool 4, and a
board that updated only at the end would show half-hour-old health for half an hour.

### MediaMTX — `:9998/metrics`

The gateway's own view: bytes and sessions per path. **Its metrics endpoint permits only
loopback by default**, so a scrape from a sibling container answers `401`. `ops/mediamtx/mediamtx.yml`
declares an `authInternalUsers` list that restores the two built-in entries verbatim and adds a third
with `metrics` permission only — no `api`, no `pprof` — so a scraper cannot control the gateway. The
password is a local development value, like the MinIO one; a deployment overrides it.

---

## 7. Alert rules

| rule | condition | `for` | why that number |
|---|---|---|---|
| `SaakshiCameraDown` | `saakshi_worker_camera_connected == 0` | 5m | the ticket's number, and an order of magnitude longer than the worst backoff step (30 s), so walking the full 2s→30s ladder never pages anybody |
| `SaakshiCameraStarved` | `seconds_since_frame > 120` | 2m | more than twice the worst observed **healthy** stall (54.6 s) |
| `SaakshiTrustDrop` | `max_over_time(trust[6h]) − trust > 20` | 10m | against the camera's own recent maximum; 6 h spans several 23.6-minute sweeps |
| `SaakshiFpsUnmeasurable` | `fps_unmeasurable == 1` | 1h | **info**, not a fault — usually the network |
| `SaakshiEncoderClockDrift` | `abs(drift{meaning="live"}) > 5000` | 30m | live only; five seconds of clock error corrupts route reconstruction |
| `SaakshiReadRateCollapse` | `rate < 0.2 × own baseline`, baseline > 1 | 15m | see §2.3; the `> 1` guard keeps genuinely quiet cameras out |
| `SaakshiBusLagRising` | `lag > 1000 and deriv(lag[15m]) > 0` | 10m | one batch is 256, so 1,000 is ~4 batches behind; **rising**, because a burst that drains is the system working |
| `SaakshiNoBusConsumer` | `consumers == 0 and length > 0` | 10m | |
| `SaakshiInvalidPayloads` | `rate > 0` | 15m | dropped and counted is correct; a *sustained* rate means detections are being lost |
| `SaakshiComponentDown` | `up{job="saakshi-api"} == 0` | 2m | the API only — the workers are batch jobs |
| `SaakshiApiLatencyOverTarget` | `p95 > 0.2s` | 10m | the stated target |
| `SaakshiApiErrorRate` | `5xx / all > 2%` | 10m | |
| `SaakshiDatabaseUnreachable` | `saakshi_db_reachable == 0` | 2m | |
| `SaakshiAuditChainForked` | `forks > 0` | — | no `for:`; there is no acceptable non-zero value |
| `SaakshiRelayQueueDeep` | `queued > 20` | 5m | |

### Proving the camera-down rule

```bash
# with the analytics worker running against a feed you control
docker compose exec mediamtx sh -c 'pkill -f "rtsp://127.0.0.1:8554/<path>"'   # or stop the publisher
curl -fsS localhost:9090/api/v1/alerts | jq '.data.alerts|map(.labels.alertname)'
```

The alert appears in `pending` immediately and flips to `firing` after the rule's `for: 5m`. Both
states are returned by `/api/v1/alerts`, so check `.state`, not merely the presence of the name.

---

## 8. Security and the deploy (hand-off to D4-01)

- **`/metrics` is unauthenticated, like `/health`.** On the compose stack Prometheus scrapes it over
  a private network and the alternative is a credential in the compose file that buys nothing. It is
  **read-only and contains no PII**: camera external ids, counters and timings. It contains no plate
  text, no crop URIs and no operator identity.
- **It is hidden from the OpenAPI document** (`hide: true`) — it is Prometheus text, not JSON, and
  not part of the typed web client. `packages/web/src/lib/api/openapi.json` is unaffected.
- **For the Railway deploy**, `host.docker.internal` does not exist. Every job in
  `ops/prometheus/prometheus.yml` needs its target replaced with the deployed service address, and
  `/metrics` should be bound to a private interface or put behind the platform's own auth. The
  MediaMTX metrics password must move to the secret store.
- Cardinality: the only unbounded label is `camera`. At 80,000 cameras the per-camera families are
  the ones to shard or drop first; the estate aggregates (`saakshi_estate_*`) are designed to remain
  useful without them.
