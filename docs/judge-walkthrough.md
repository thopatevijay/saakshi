# SAAKSHI — a ten-minute walkthrough for the screening committee

Everything below is a live system you can click. Nothing is a mock-up, and every number on screen
was produced by the thing it describes.

**Console:** https://web-production-6bff.up.railway.app
**Credentials:** in the submission form (they are not in this repository, deliberately).

You land on the **camera registry**, with a "Start here" panel offering the three steps below. If
someone has dismissed it, the links are here too.

---

## Before you start: what is real, and what is not

This project is scored partly on honesty, so the boundary is drawn first rather than buried.

| | |
|---|---|
| **Real, measured on the government sandbox** | every sighting and its timing, the measured FPS and resolution per camera, plate reads and their confidences, trust scores, and the plate crops in the evidence panels |
| **Real, from the supplied estate** | the 30 sandbox cameras, by catalogue sync |
| **Operator-supplied** | 50 camera locations, imported as a CSV — **the sandbox catalogue carries no coordinates at all**, only `{id, name}` |
| **Synthetic, and labelled as such in the product** | the `TRACEFIX-*` cameras behind the trace demonstration, the watchlist rows, and the second vehicle in the cloned-plate example |
| **Not present at all** | any VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity, and any face recognition. Connectors are specified with a mock provider; **no biometrics are processed** |

---

## 1 · Inspect a camera on the map  →  `/registry`

Model 1's compulsory deliverable. The map plots every camera that has coordinates; the tray beside
it lists the ones that do not, rather than dropping them.

**What to look for**

- **The pins are coloured by measured trust, not by declared capability.** Open one and read the
  breakdown: what the camera *claims* against what its stream actually delivered.
- **The "no coordinates" tray.** Around 30 real cameras sit there. That is not an oversight — it is
  the finding. The upstream catalogue returns `{"id": "cam01", "name": "01 Chiman bhai Bridge"}` and
  nothing else, so an estate arrives as an incomplete inventory. Showing that gap is the point of the
  GIS layer; hiding it would be the failure.
- **A `dead` camera.** A camera still listed upstream whose endpoint no longer answers. *"A dead
  camera is worse than no camera, because it creates false assurance."*
- **The map makes zero external requests.** The basemap is a 28 MB PMTiles extract served by the app
  itself. No tile API key, nothing that phones home mid-investigation, and it works on an isolated
  police network. Check the network tab.

## 2 · Trace a vehicle across the estate  →  `/trace?plate=GJ01AB1234`

**A purpose is required before the query runs**, and the request is written to the audit chain. That
is deliberate: a system that can follow any vehicle on request needs a reason recorded against every
use of it.

**What to look for**

- Every sighting of one registration, in order, with the route between consecutive sightings
  reconstructed and **each segment labelled `observed` or `inferred`**. The product never draws a
  line it cannot justify.
- On this hosted instance the segments read **`inferred_unroutable`**: OSRM is not deployed here
  (see *Limitations*), so travel time cannot be snapped to the road graph. The trace itself is
  unaffected, and the label says exactly why rather than drawing a straight line and hoping.
- **The cloned-plate case is in the data, and the detector cannot assess it here.** Two sightings of
  `GJ01AB1234` sit 9.24 km apart with 30 seconds between them — physically impossible for one
  vehicle. Impossible-transition detection needs a **road graph** to say how long that journey should
  take, and the road network is not loaded on this hosted instance (same reason OSRM is absent). So
  the analyser reports, in its own words: *"10 transitions were examined and NONE could be assessed…
  '0 impossible transitions' here means '0 transitions were testable', not 'the estate is clean'."*
  That is the product refusing to claim a clean result it did not earn. The detector is demonstrated
  against the road graph in `docs/cloning-detection.md`.
- The evidence strip shows **real plate crops**, served as presigned URLs that expire in 15 minutes.

## 3 · Inspect an alert and why it fired  →  `/alerts`

Seven alerts, raised by the watchlist engine on its own from the estate's measured ANPR output.

**What to look for**

- **The "why" payload.** The plate read, its confidence, the match type (exact or fuzzy), the edit
  distance, and the watchlist entry it hit. An officer is never asked to trust a verdict.
- **The severity distribution is 5 low · 2 medium · 0 high · 0 critical**, and that is the finding
  rather than a shortfall. Five are exact matches against watchlist rows whose own note reads
  *"SELECTED FROM MEASURED ANPR OUTPUT, NOT FROM A VEHICLE REGISTRY"* — and the queue carries that
  note rather than dressing them up as vehicle records.
- **The highest-confidence read of the entire run raised nothing.** `757508300` at 0.888 confidence
  matched no watchlist entry, and the system correctly stayed silent.
- You can **acknowledge** an alert. Try it — the transition is written to the audit chain.

---

## If you have longer

| Screen | What it demonstrates |
|---|---|
| `/evidence` | The retention clock: how long each camera's footage survives, and what is expiring soon |
| `/sizing` | Infrastructure and cost for an estate of any size, from this deployment's own measured throughput |
| `/video-wall` | Live HLS from the sandbox, relayed so that nine tiles cost the department gateway one copy of the stream rather than nine |
| `/audit` | The chain of custody — **sign in with the auditor credential**; see below |

### The access model is real, and you will hit it

Sign in with the **auditor** credential and `/alerts` will refuse you. That is not a fault: an
auditor holds `registry:read`, `trust:read`, `audit:read` and `audit:export` and deliberately
**no** `video:view` and **no** `trace:run` — *an auditor who can change the thing being audited is
not an auditor*, and granting live video would widen the surveillance surface for no audit purpose.

The **operator** credential is the one for steps 1–3. It cannot write anything: a watchlist write
returns `403 {"error":"forbidden","message":"role 'operator' may not perform this action"}`, and a
camera delete returns `403`. Try it.

---

## Limitations on this hosted instance, stated plainly

The deployment is the **control plane**. Video analytics runs where the hardware is.

| Not deployed | Consequence | Why |
|---|---|---|
| **OSRM** | route segments read `inferred_unroutable` | a road-graph service and a ~150 MB extract; the trace degrades honestly rather than failing |
| **MediaMTX** | the WHEP low-latency panel is unavailable; the HLS relay still works | WHEP is served by our own edge gateway, never by the sandbox |
| **Prometheus / Grafana** | `/metrics` is served but nothing scrapes it | reproducible with `docker compose up` |
| **Analytics / prober workers** | they run locally and write to this database over TLS | Python + YOLO11 + OpenCV, and this platform has no GPU |

Export bundles are written inside the container and do not survive a restart. Ask and we will
generate one live.

---

## Running it yourself

```bash
git clone https://github.com/thopatevijay/saakshi && cd saakshi
cp .env.example .env          # fill in the sandbox host and cookie
docker compose up -d          # Postgres/PostGIS/Timescale, Valkey, MinIO, MediaMTX
npm ci && npm run db:migrate
npm start                     # API on :4000, console on :3000
```

`docs/deployment.md` is the full runbook. Its § 9.1 covers the **Cloudflare Tunnel fallback** —
one binary, no account — which exposes a local stack, live feeds and all, without migrating any
data. That is how a live-video demonstration is given if the hosted instance cannot show one:
tested end to end, including `Range` requests for the basemap.
