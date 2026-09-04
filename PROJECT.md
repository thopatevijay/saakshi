# SAAKSHI — साक्षी, "the witness"

> A camera estate that can be trusted, queried, and produce evidence.
> Submission for the **Gujarat Police Innovation Challenge 2026** (Sentinel).

---

## 0. Hard facts (verified from the official portal, 3 Sep 2026)

| Item | Value |
|---|---|
| Organiser | Home Department, Govt. of Gujarat / State Crime Records Bureau (SCRB) |
| Portal | https://sentinel.gujarat.gov.in |
| Tech partner | i-Hub Gujarat · Knowledge partners: NFSU, DA-IICT (Dhirubhai Ambani University) |
| **Registration + submission close** | **7 Sep 2026** |
| Shortlisting | 7 Sep 2026, evening |
| Grand Finale (in person) | 10–11 Sep 2026, i-Hub Gujarat, Gandhinagar |
| Results | 11 Sep 2026 |
| Prize pool | ₹51,00,000 (Phase 1 ₹18L + Phase 2 ₹31L + ₹2L additional) |
| Our category | **Category 1** — Student / Researcher / **Professional** / DPIIT startup |
| Our entry | **Solo** (Vijay Thopate), registered as Professional |
| Helpdesk | +91 95370 89982 · sentinel.hackathon@gujarat.gov.in (Mon–Sat 10:00–18:00) |

**Phase 1 is remote.** Submission is entirely by link (unlisted YouTube / Drive / hosted URL / Git repo).
Travel to Gandhinagar is required **only if we place in the top 6**. Shortlist drops 7 Sep evening,
event starts 10 Sep — roughly 2.5 days of travel notice. *Confirm by phone; the portal never states
this in words.*

### Non-negotiable requirements pulled from the problem statement

1. **Model 1 (Centralised CCTV Registry & GIS Mapping) is COMPULSORY** and must be combined with
   at least one other model.
2. **ANPR is the only mandatory analytic.** Proof: the bonus list reads *"Additional reliable
   analytics beyond the mandatory ANPR requirement."* Face recognition is **not** required.
3. **The watchlist database is ours to build.** *"Participants may create and use their own
   representative watchlist database."* There is **no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS
   access.* Government-DB integration must be *designed and integration-ready*, never claimed as live.
4. **Solutions should use open-source technologies** (stated on the About page). This rules out buying
   a commercial ANPR API as a core dependency.
5. **Mock-ups, animations and concept videos are explicitly rejected.** Working backend required.
6. Ten mandatory design dimensions must appear in the deck/HLD (§9).
7. Test case: onboard ~50 heterogeneous cameras; a **vehicle registration number is handed to us on
   the day**; produce its complete timestamped, location-wise route + live watchlist alerting.

### Open questions to resolve with the helpdesk (Day 0)

- [ ] The page references *"five reference solution models"* / *"Reference Model 1–5"* but only
      Models 1–4 + Hybrid are published. Is Hybrid = Model 5, **or is there an official Problem
      Statement document behind the login?** (No PDF exists anywhere on the public site.)
- [ ] Confirm Phase 1 is remote and in-person attendance applies only to the top 6.
- [ ] Confirm a solo professional is scored in **Category 1**, not pushed to Category 2.
- [ ] Are the sandbox RTSP endpoints reachable from a datacenter/cloud IP, or India-only /
      session-restricted? (Determines whether we can use a cloud GPU — see §7.)

---

## 1. The pain we are actually solving

The problem statement says 26 departments run 26 CCTV silos. True, but the deeper pains are the
ones stated between the lines, and they are the ones nobody will build for:

| # | Real pain | Evidence from the problem statement | Our answer |
|---|---|---|---|
| P1 | **Gujarat does not know what cameras it owns.** | *"there is currently no centralised mechanism to systematically identify, map, and manage these assets"* — this is literally why Model 1 exists. | Registry + GIS (Pillar 1) |
| P2 | **A dead camera is worse than no camera** — it creates false assurance. An inventory of blind cameras is worthless. | Model 1 asks for *"camera health and maintenance-status monitoring"* and *"gap-analysis reports for ageing infrastructure"* | **Camera Trust Score** (Pillar 1) |
| P3 | **Evidence evaporates on a 7–15 day clock that varies per department.** Report a crime on day 12 and nobody can tell you what footage still exists. | *"some systems storing footage for 7 days and others for 15 days or more"* | **Retention / evidence clock** (Pillar 4) |
| P4 | **Indian ANPR gives sparse, noisy reads.** Exact-string matching finds nothing. | Their own guide warns about blur, night, mixed codecs, oblique angles | **Confusion-aware fuzzy matching + best-shot OCR** (Pillar 3) |
| P5 | **100,000 cameras cannot be centrally streamed.** 160 Gbps of video is not a budget. | `/problems` Model 4 as written requires exactly this | **Edge inference, metadata-only backhaul** (Pillar 2) |
| P6 | **Alert fatigue kills every alert system.** 80k cameras with naive alerting is an unusable firehose. | Not stated — this is the gap | **Dedupe + severity + verify-in-3-seconds UI** (Pillar 4) |
| P7 | **Unauditable AI is not evidence.** A forensic university is the knowledge partner. | NFSU is a *forensic sciences* university and helps evaluate | **Hash-chained audit log + export manifests** (Pillar 4) |
| P8 | **Plate cloning is rampant and undetected in India.** | Not stated — this is the gap | **Impossible-transition detection** (Pillar 3) |

---

## 2. Locked architecture decision: **Model 1 + Model 4**

Mandatory registry/GIS foundation, plus **Centralized Analytics & AI Insights** built on a
vendor-neutral federation layer.

> **Why not Model 3, and why the numbering matters.** The portal carries two model definitions that
> contradict each other. `/problems` describes Model 3 as *"VMS Federation & Middleware Integration"*
> — a software layer. But `/evaluation-criteria` (an **unlinked** page, found 2026-09-04, see
> `BL-01`) scores Model 3 as **hardware**: *"the transponder/encoder must be stable, compatible,
> compact, and suitable for field deployment"*, secure boot, PoE support, rugged design. We build no
> hardware, so 60 of its 100 marks would be unreachable. **Escalated to the helpdesk: which
> numbering is authoritative.** Until answered, we optimise for the scored rubric, which is the
> document that decides marks.

### Why Model 1 + Model 4 fits what we are building

On `/evaluation-criteria` the models read as **complementary layers, not four alternatives** — Model
4 is explicitly scored on how well it *"integrates Cameras, Registry (M1) and Control Room (M2)"*.

| Model 1 rubric | Marks | Our answer |
|---|---|---|
| Data Accuracy & Registry Completeness | 25 | Registry + **trust score** — measured, not declared |
| GIS Visualization & Usability | 20 | MapLibre registry map, trust overlay, gap analysis |
| API Design & Integration Readiness | 20 | OpenAPI registry API + `docs/registry-api.md` |
| Scalability & Performance | 20 | Edge-metadata architecture; sizing model |
| Security & Access Control | 10 | RBAC + hash-chained audit chain |
| Innovation & Value Addition | 5 | Trust score, retention clock |

| Model 4 rubric | Marks | Our answer |
|---|---|---|
| System Architecture & Integration Depth | 25 | Adapter framework unifying cameras + registry + control room |
| Core Functional Modules & Workflow Automation | 25 | *"discovery, connectivity, status, health, uptime, alerting"* — literally the trust prober plus the alert engine |
| Reliability, Performance & Scalability | 20 | Benchmarks below, measured; *"pre-tested data instead of live production data"* matches the VOD sandbox |
| Security & Access Control | 20 | RBAC, purpose binding, audit chain, export manifests |
| Innovation & Intelligence | 5 | Fuzzy plate matching, cloning detection, route inference |
| API Ecosystem & Extensibility | 5 | Documented adapter + provider interfaces |

**Model 4 as written on `/problems` (a fully centralised VMS) remains indefensible** and we say so:
80,000 cameras × 2 Mbps ≈ **160 Gbps** of sustained ingest, and it requires 26 departments to
surrender infrastructure they own and hold AMCs on. Our reading of Model 4 is the
`/evaluation-criteria` one — *analytics and insight over a federated estate*, with video staying
where it is. That distinction is a slide, not a footnote.

**Model 2 (Stream Unification)** is partially addressed by the video wall, but two of its five
criteria are latency-weighted (25 marks for stream performance) and the sandbox is VOD HLS, so we
do not claim it as a primary model.

### Stated performance benchmarks — design to these, then **measure** them

| Metric | Target | Where we prove it |
|---|---|---|
| Camera records / endpoints | **1,00,000+** | D3-08 sizing model, D1-02 load test |
| API response latency | **< 200 ms** | D1-02 |
| Dashboard load time | **< 3 s** | D1-08 |
| Detection / processing accuracy | **> 90%** | D2-01 — report measured, day and night separately |
| System uptime | **> 99%** | D3-10 |
| Concurrent users, no degradation | **500+** | D1-02 |

Bonus weightage is stated for: innovation beyond scope · **AI/ML integration** · state-level
scalability · **low-bandwidth optimisation** · user-centric design. Global themes: technical
soundness, scalability, security & access control. **UI/UX is called out as "a significant
evaluation factor"** — worth 25/100 in Model 2 and material everywhere.

### System shape

```
┌──────────────────────────────────────────────────────────────────────────┐
│ SOURCES (department-owned, unchanged)                                    │
│ IP cams · analog+DVR · vendor VMS · GSRTC mobile cams · private feeds    │
└───────────────────────────┬──────────────────────────────────────────────┘
                            │ RTSP/TCP · ONVIF · HLS · WHEP · vendor SDK
┌───────────────────────────▼──────────────────────────────────────────────┐
│ EDGE / DISTRICT NODE  (deployed per district — ~33 nodes statewide)      │
│                                                                          │
│  ┌──────────────┐   ┌──────────────────┐   ┌───────────────────────┐    │
│  │ Adapter      │──▶│ Stream Gateway   │   │ Trust Prober          │    │
│  │ Framework    │   │ (MediaMTX)       │   │ blur·night·tamper·PTS │    │
│  │ RTSP/ONVIF/  │   │ relay → HLS/WHEP │   │ drift·measured FPS    │    │
│  │ HLS/WHEP/NVR │   └────────┬─────────┘   └──────────┬────────────┘    │
│  └──────────────┘            │                        │                 │
│                    ┌─────────▼────────────┐            │                 │
│                    │ Analytics Worker     │            │                 │
│                    │ YOLO11 → ByteTrack   │            │                 │
│                    │ → best-shot → ANPR   │            │                 │
│                    └─────────┬────────────┘            │                 │
│                              │  EVENTS ONLY (~2 KB/s/cam), never video   │
└──────────────────────────────┼─────────────────────────┼─────────────────┘
                               ▼                         ▼
                      ╔════════════════════════════════════════╗
                      ║ EVENT BUS (Valkey Streams → Kafka)     ║
                      ╚════════════════┬═══════════════════════╝
┌──────────────────────────────────────▼───────────────────────────────────┐
│ STATE CORE                                                               │
│  PostgreSQL 16 + PostGIS + TimescaleDB   │  MinIO (evidence crops)       │
│  registry · sightings · watchlist · alerts · routes · audit chain        │
└──────────────────────────────────────┬───────────────────────────────────┘
┌──────────────────────────────────────▼───────────────────────────────────┐
│ SERVICE LAYER (Node + TypeScript / Fastify)                              │
│  Registry API · Trust API · Watchlist API (provider interface) ·          │
│  Alert engine (dedupe+severity) · Route engine (OSRM + road graph) ·      │
│  Query compiler · Audit chain · Export bundler                           │
└──────────────────────────────────────┬───────────────────────────────────┘
┌──────────────────────────────────────▼───────────────────────────────────┐
│ CONSOLE (Next.js · MapLibre · hls.js/WHEP)                               │
│  GIS registry · gap analysis · video wall · vehicle trace · alert queue  │
│  retention clock · sizing calculator · audit viewer                      │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 3. Pillar 1 — A registry that tells the truth  *(Model 1, compulsory)*

Not a metadata table. Every camera carries a **Trust Score** computed from its actual stream.

### Trust Score components (all classical CV — deterministic, explainable, cheap at 80k scale)

| Signal | Method | Why it matters |
|---|---|---|
| Reachable | RTSP/TCP connect success + time-to-first-frame | Is it alive at all |
| Decodable | successful decode of first IDR | Alive ≠ usable |
| **Measured FPS vs declared** | count frames over a 30 s PTS window | *Their guide warns declared FPS lies. We measure it and show the delta per camera.* |
| Resolution/codec drift | actual vs `/api/ingest` declared | Registry accuracy |
| Focus / blur | variance of Laplacian on centre crop | Out-of-focus cameras produce no plate reads |
| Night usability | luma histogram + read-rate after sunset | Half the estate is useless at night and nobody knows which half |
| Tamper / occlusion | long-window frame differencing + edge density collapse | Covered or spray-painted lens |
| **Clock drift** | PTS vs wall clock at connect | **A camera with a wrong clock corrupts every route reconstruction it contributes to** |

Aggregated to `trust_score` 0–100 with a per-signal breakdown. **Never a black box** — the UI shows
which signal cost the camera its points.

### Model 1's five named deliverables — all explicitly produced

- [ ] Working registry portal with GIS map view
- [ ] Bulk import + manual entry + API onboarding, all three demonstrated
- [ ] Sample onboarded camera-metadata dataset (exported from the sandbox estate)
- [ ] **Registry API documentation** → `docs/registry-api.md` (OpenAPI + prose)
- [ ] **Sample gap-analysis report** → `docs/gap-analysis-sample.md` (generated, not hand-written)

### Gap analysis
Camera coverage polygons intersected against the OSM road network in PostGIS → uncovered road
kilometres by district, junctions with zero *trusted* coverage, and ageing/low-trust clusters.
This is what makes the registry a **planning instrument** rather than a list.

---

## 4. Pillar 2 — Federation fabric  *(Model 4 integration depth)*

### Adapter framework
One interface, four implementations + one stub. Onboarding a vendor = writing an adapter, never
touching the core.

```ts
interface CameraAdapter {
  kind: 'rtsp' | 'onvif' | 'hls' | 'whep' | 'nvr-file';
  probe(cfg: CameraConfig): Promise<CameraCapabilities>; // codec, res, true fps, audio, ptz
  open(cfg: CameraConfig): Promise<StreamHandle>;
  close(h: StreamHandle): Promise<void>;
  health(cfg: CameraConfig): Promise<HealthSample>;
}
```

### The eight sandbox failure modes — pre-declared by the organisers, each handled and demonstrated

The Resources page is simultaneously a trap list and a scoring rubric. We handle all eight and show
a checklist slide:

1. ✅ **RTSP forced over TCP** everywhere (`rtsp_transport=tcp`); HLS fallback if 8554 is blocked.
2. ✅ **Never trust `CAP_PROP_FPS`** — measured, and the discrepancy is surfaced as a registry field.
3. ✅ **All timing from PTS**, never arrival time (they replay a buffered GOP on connect; an
   arrival-time tracker computes impossible velocities on every reconnect).
4. ✅ **Non-uniform frame intervals** tolerated — gaps are not disconnects; motion models use real
   PTS deltas.
5. ✅ **Reconnect with exponential backoff** (2 s → cap 30 s), never a tight loop.
6. ✅ **Join-time decoder warnings are logged, not fatal** (`Error constructing the frame RPS`,
   `Could not find ref with POC` self-correct at the first IDR).
7. ✅ **Mixed H.264/H.265 and mixed resolutions** — per-camera decoder + batch shape from
   `/api/ingest`, no fixed-shape inference batch.
8. ✅ **Loop-point scene discontinuity survived** — track IDs, background models and galleries reset
   on a hard cut instead of assuming infinite continuity.

Plus: **catalogue-driven, never URL-pattern-driven** (`GET /api/ingest` is the contract), consume
only (never publish to the gateway), and open only the cameras actively being processed.

### The scalability argument is arithmetic, not a promise

| | Central video (Model 4) | Metadata at edge (ours) |
|---|---|---|
| 80,000 cameras @ 2 Mbps | **160 Gbps** sustained | — |
| 80,000 cameras @ ~2 KB/s events | — | **≈1.3 Gbps** |
| Ratio | | **~125× less backhaul** |

Video stays where it is. Only events travel. Video is pulled on demand, per incident, over the
existing feed path.

---

## 5. Pillar 3 — Vehicle trace with honest confidence  *(the test case)*

### Pipeline
```
frame (PTS) → motion gate → YOLO11 vehicle detect → ByteTrack
  → per-track BEST-SHOT selection (plate area × sharpness × frontality)
  → plate detect → rectify/deskew → OCR
  → multi-frame vote across the track → sighting + confidence + crop
```

Two moves do most of the accuracy work, and neither requires a CV specialist:
- **Best-shot selection** — OCR one optimal frame per track, not every frame.
- **Multi-frame voting** — aggregate reads across a track to cancel per-frame OCR noise.

### Confusion-aware fuzzy plate matching — the single highest-leverage feature
Indian plate OCR reliably confuses `0/O/D`, `1/I/L`, `8/B`, `5/S`, `2/Z`, `6/G`, `4/A`, `7/T`.
**Teams doing exact-string matching will get zero hits on the designated vehicle.**

We normalise every read, index it, and query with a weighted edit distance where confusable
substitutions cost less than arbitrary ones. Output: **ranked candidates with confidence**, not a
boolean. Also validate against the Indian plate grammar (`GJ 01 AB 1234` — state, RTO, series,
number) so structurally impossible reads are corrected or down-weighted.

### Route reconstruction
Sparse sightings + OSM road graph + travel-time priors (OSRM) → a continuous timestamped route that
**explicitly distinguishes observed sightings from inferred segments**. Saying what we do not know
is the whole point.

### Impossible-transition detection → plate cloning
Same plate at two cameras separated by a distance the fastest legal route cannot cover in the
elapsed time ⇒ either an OCR misread or a **cloned plate**, and the system states which is more
likely (based on read confidence and edit distance to plausible neighbours). One detector, two uses.
Plate cloning is a real, widespread, undetected Indian crime problem.

### Cut (solo scope)
- ❌ Vehicle re-ID embeddings — specialist CV work; best-shot + voting recovers most of the benefit
- ❌ Make/model classification
- ✅ Colour (HSV histogram in the vehicle box) and coarse body type (detector class) — cheap, honest

---

## 6. Pillar 4 — Evidence & alert layer  *(what a department uses daily)*

### Watchlist service — integration-ready, never faked
`WatchlistProvider` interface with a **MockProvider** (our representative dataset) plus a written
connector specification for each real source. Field shapes modelled on the actual systems so a real
integration is a connector swap, not a redesign:

| Source | Entity | Key fields we model |
|---|---|---|
| VAHAN | vehicle | registration no., make, model, colour, owner ref, RC status |
| SARTHI | person (driver) | DL no., name, validity |
| eGujCop (CCTNS) | person / vehicle | FIR ref, wanted status, stolen-vehicle record, missing person |
| AFIS / NAFIS | person (biometric) | subject ref only — **no biometric processing in our system** |

### Alerts that survive contact with a control room
- **Dedupe** by `(entity, camera, time-window)` — one alert per vehicle per camera per N minutes.
- **Severity** from watchlist category, not from a model's opinion.
- **Every alert carries its "why"**: the plate crop, the camera, the PTS timestamp, the matched
  record, the match type (exact / fuzzy + distance), and the confidence.
- If an officer cannot verify an alert in three seconds, it is noise. That is the design constraint.

### Retention / evidence clock — the sleeper feature
For any location + time window: which cameras covered it, whether that footage is **still alive**,
and **when it expires** — computed from the registry's per-department retention field. Officers can
request preservation *before* evidence is gone. Nearly free to build; the most immediately useful
thing in the whole system for a real department.

### Tamper-evident audit chain
Every search, trace, and export appended to a **hash-chained** log:
`hash_n = SHA256(prev_hash ‖ canonical_json(entry))`. Each entry records actor, badge, role,
**purpose**, case/FIR reference, parameters, and result count. Export bundles ship with a manifest
hash so integrity is provable later. NFSU is a forensic sciences university — this is
chain-of-custody language, and it is the responsible-surveillance answer without a lecture.

### RBAC
`admin · supervisor · operator · auditor`. Auditor can read the chain and nothing else. Operators
cannot export without a case reference.

---

## 7. Tech stack, services, and what we buy

### Stack (all open source — a **stated requirement** on the About page)

| Layer | Choice | Version / package | Rationale |
|---|---|---|---|
| CV workers | **Python 3.11** | `ultralytics` (YOLO11), `supervision`, ByteTrack, `opencv-python`, `av`/PyAV | Unavoidable for vision. Kept thin: connect → infer → publish JSON |
| Plate OCR | **`fast-plate-ocr`** (ONNX) primary; **PaddleOCR** fallback | Apache-2.0 | Fast, open, no per-read licence |
| Plate detect | YOLO plate model (open weights, licence-checked) | — | Detector → crop → OCR beats end-to-end here |
| API | **Node 22 + TypeScript + Fastify** | `fastify`, `zod`, `drizzle-orm`, `pino` | Home turf; where most of the build lives |
| Data | **PostgreSQL 16 + PostGIS 3.4 + TimescaleDB** | `timescale/timescaledb-ha:pg16` (PostGIS included) | Exactly their suggested stack; one image |
| Event bus | **Valkey Streams** | `valkey/valkey:8` | BSD-licensed Redis drop-in. Kafka documented for production |
| Object store | **MinIO** | `minio/minio` | S3-compatible, matches their suggestion, for evidence crops |
| Stream gateway | **MediaMTX** | `bluenviron/mediamtx` | Apache-2.0. **The same tool the organisers use to serve the sandbox** — relays RTSP → HLS/WHEP for our video wall |
| Routing / travel time | **OSRM** + Geofabrik Gujarat extract | `osrm/osrm-backend` | Self-hosted, free, for route reconstruction and impossible-transition math |
| Frontend | **Next.js 15 + React 19 + Tailwind** | — | Where "platform maturity" points live |
| Map | **MapLibre GL JS + self-hosted PMTiles** | `maplibre-gl`, `pmtiles` | **No external tile API.** Basemap is one local file — works on an air-gapped police network. Architectural strength, not just a cost saving |
| Video in browser | **hls.js** (grid) + **WHEP** (low-latency single camera) | — | Uses both endpoints they expose |
| Charts | **Recharts** | — | Sizing calculator, trust distributions |
| Observability | **Prometheus + Grafana** | — | Hits the "health monitoring" bonus item directly |
| Deploy | **Docker Compose** (one command); K8s manifests in the HLD | — | Reviewable by a judge in minutes |

### Query compiler: provider-neutral by construction

The natural-language → query compiler sits behind a `QueryCompiler` interface with **four**
implementations: `openai` (primary), `anthropic`, `ollama` (local), and `none` (degrades to the
deterministic filter UI).

**Primary is OpenAI** — its Structured Outputs with `strict: true` constrains decoding against our
JSON schema, so schema-invalid output is impossible rather than merely unlikely. Model: a small/fast
tier (`gpt-4.1-mini` class); latency matters more than reasoning depth for text-to-DSL.

This is not redundancy for its own sake. The challenge requires an *"open, modular, scalable, secure,
standards-based, and vendor-neutral"* architecture that avoids vendor lock-in. Three working
providers behind one interface turns that stated principle into a **live demonstration**: change one
config value, same query, same result. No proprietary service is load-bearing — with
`QUERY_COMPILER=ollama` or `none`, the system is fully functional and entirely open-source.

Safety never depends on the provider: zod validates every compiled filter, invalid output is
rejected, the officer edits and approves the filter before it runs, and only the DSL becomes SQL.

### Third-party services / spend

| Item | Decision | Cost |
|---|---|---|
| **ANPR API** (Plate Recognizer, etc.) | ❌ **Do not buy.** Closed cloud ANPR violates the stated open-source expectation, breaks the no-vendor-lock-in principle, sends police data off-network, and is unaffordable per-read at 80k cameras. Optionally cite one as an accuracy *benchmark* if time permits. | ₹0 |
| **Map tiles** (MapTiler/Mapbox) | ❌ Not needed — self-hosted PMTiles extract | ₹0 |
| **Routing API** (Google/Mapbox Directions) | ❌ Not needed — self-hosted OSRM | ₹0 |
| **OSM data** | Geofabrik `gujarat-latest.osm.pbf` (~150 MB) | Free |
| **LLM API** (query compiler) | **OpenAI** primary (small/fast tier), Anthropic as the swap demo. Very low volume — a few hundred queries | ~₹200–400 |
| **Cloud GPU** | *Conditional.* Try local Apple Silicon (MPS) first. If throughput is short, rent **India-region** GPU. **Blocker to test on Day 0: are the sandbox RTSP endpoints reachable from a datacenter IP?** Gov networks frequently block those ranges. Candidates: Jarvislabs / E2E Networks (India), AWS `ap-south-1` g5.xlarge. ~40 GPU-hours | ₹0–5,000 |
| **Public demo URL** (judges get test creds) | **Cloudflare Tunnel** — free, exposes the local stack without migrating data, and the ingest workers keep their network path to the feeds. Optional Vercel deploy of the frontend on top | ₹0 |
| **Domain** | Optional vanity domain | ₹0–900 |

**Total expected spend: ₹200 – ₹6,000.** Nearly zero, and that is by design — an all-open-source,
self-hostable stack *is* the correct answer for a state police deployment and doubles as a
cost-benefit argument.

---

## 8. Data model (concrete)

```
departments          (id, name, code, contact_json)
users                (id, name, badge_no, role, department_id, password_hash)

cameras              (id, external_id, name, department_id,
                      location geography(Point,4326), address, district,
                      camera_type analog|ip, mount static|mobile,
                      declared_codec, declared_fps, declared_resolution,
                      vendor, vms_platform, retention_days, storage_type cloud|local,
                      adapter_kind, endpoints jsonb, onboarded_at, status, trust_score)

camera_health_checks (HYPERTABLE: camera_id, checked_at, connectable, decodable,
                      measured_fps, actual_resolution, actual_codec, blur_score,
                      luma_mean, night_usable, tamper_score, pts_drift_ms,
                      trust_score, breakdown jsonb)

camera_coverage      (camera_id, fov_polygon geography, covered_road_ids[])
road_network         (id, geom geography(LineString), name, highway_class)   -- OSM import

sightings            (HYPERTABLE: id, camera_id, ts, frame_pts_ms, track_id,
                      class, bbox jsonb, det_confidence,
                      vehicle_color, vehicle_type, crop_uri, ingested_at)
plate_reads          (id, sighting_id, raw_text, normalized_text, confidence,
                      is_best_shot, vote_count, crop_uri)

vehicle_identities   (id, canonical_plate, first_seen, last_seen)
identity_sightings   (identity_id, sighting_id, link_method plate_exact|plate_fuzzy,
                      link_confidence)

watchlist_entries    (id, category stolen_vehicle|wanted_person|missing_person|
                      blacklisted_vehicle|suspect,
                      entity_type vehicle|person, plate_normalized, person_ref,
                      source_system VAHAN|SARTHI|eGujCop|AFIS|NAFIS|manual,
                      source_ref, severity, valid_from, valid_to, active, meta jsonb)

alerts               (id, watchlist_entry_id, sighting_id, camera_id, ts,
                      match_type exact|fuzzy, match_distance, confidence, severity,
                      dedupe_key, status new|ack|dismissed|escalated,
                      acked_by, acked_at)

routes               (id, identity_id, requested_by, requested_at, params jsonb)
route_segments       (route_id, seq, from_sighting_id, to_sighting_id,
                      observed bool, path geography(LineString), travel_time_s,
                      inferred_confidence, anomaly none|impossible_transition)

audit_log            (id, ts, actor_id, action, target_type, target_id,
                      purpose, case_ref, params jsonb, result_count,
                      prev_hash, hash)
export_bundles       (id, created_by, created_at, items jsonb,
                      manifest jsonb, manifest_hash)
onboarding_responses (department_id, questionnaire jsonb, submitted_at)
```

---

## 9. Deliverables mapped to the scoring rubric

### The 7 official evaluation areas

| # | Area | Our artefact |
|---|---|---|
| 1 | **Successful Test Case** | Live run on the government feed: onboard, view, ANPR output, vehicle trace |
| 2 | Solution Presentation | `docs/deck.pdf` — all 10 design dimensions |
| 3 | Solution Architecture | `docs/HLD.md` + diagrams |
| 4 | Working Platform & Demonstration | Hosted URL + test creds, Docker Compose, public repo |
| 5 | Video Analytics Output | Output report: plates + timestamps + crops (CSV **and** PDF) |
| 6 | Scalability & PoC Readiness | `docs/sizing-model.md` + in-product sizing calculator |
| 7 | Submission Completeness | This checklist, fully ticked |

### The 10 mandatory design dimensions (Step 3)

- [ ] Overall Architecture
- [ ] Integration Strategy
- [ ] AI & Video Analytics
- [ ] Cybersecurity Architecture
- [ ] Deployment Architecture
- [ ] Infrastructure Sizing
- [ ] Cost-Benefit Analysis
- [ ] **Department-wise Information Requirements** → `docs/department-onboarding-questionnaire.md`
      *(nobody else will produce this, and it is scored)*
- [ ] Scalability Strategy
- [ ] Future Roadmap

### Submission artefacts (due 7 Sep)

- [ ] Solution Presentation (PPT/PDF)
- [ ] Technical Proposal / HLD
- [ ] Demo video on **our own feed** (2–3 min, screen recording, working software)
- [ ] Demo video on the **government-provided feed** + output report (plates & timestamps)
- [ ] Hosted platform URL + test login credentials
- [ ] Public GitHub repository

### First-pass sizing figures (to be refined, stated as first-pass in the deck)

- Backhaul: 160 Gbps (central video) vs ~1.3 Gbps (metadata) — **~125×**
- GPU: conservatively ~25 concurrent ANPR streams per L4/A10-class GPU. Not every camera needs
  continuous ANPR — road-facing cameras are ~30% of the estate ⇒ ~24,000 × ANPR ⇒ **~960 GPUs**,
  distributed over ~33 district nodes ⇒ **~29 GPUs per district node.** A real number, not a hand-wave.
- Event storage: 80k × ~200 events/day × ~400 B ≈ 6.4 GB/day ≈ **2.3 TB/year** metadata.
- Crops: store **only** best-shots and watchlist hits ⇒ 80k × ~40/day × 15 KB ≈ 48 GB/day ≈
  **17 TB/year**, tiered hot/warm/cold.

---

## 10. Plan — Day 0 to submission

### Day 0 — tonight, 3 Sep · **RECONNAISSANCE ONLY, NO FEATURE CODE**
This is the one thing that can invalidate the plan. Do it before writing anything else.
- [ ] Log into the portal; check the Resources page for the **official Problem Statement document**
      (and the possible Model 5)
- [ ] `GET /api/ingest` → dump the full camera catalogue; record count, codecs, resolutions, true FPS
- [ ] Verify an RTSP/TCP pull decodes end to end (`scripts/recon.py`)
- [ ] Test whether the RTSP host is reachable **from a datacenter IP** → decides the GPU question
- [ ] Score every camera for plate visibility; **pick the 10–12 with usable plate geometry**
- [ ] Phone the helpdesk with the four open questions from §0

**If the feeds turn out unusable for ANPR:** pivot emphasis to Pillars 1/2/4 (registry, trust,
retention, alerting) and lean on route *inference* rather than dense reads. The plan survives; the
weighting changes.

### Day 1 — 4 Sep · vertical slice end to end
- [ ] Docker Compose up: Postgres/PostGIS/Timescale, Valkey, MinIO, MediaMTX
- [ ] Migrations for the §8 schema
- [ ] Registry ingest from `/api/ingest` → cameras on a MapLibre map
- [ ] Trust prober worker → `camera_health_checks` → trust scores rendered per camera
- [ ] Python analytics worker: RTSP/TCP + PTS + YOLO11 detections → Valkey → `sightings` in DB
- [ ] **Gate: one camera, live, detections landing in Postgres, visible in the UI**

### Day 2 — 5 Sep · the core scoring loop
- [ ] ANPR: best-shot selection + rectify + OCR + multi-frame vote; crops to MinIO
- [ ] Plate normalisation + confusion-aware fuzzy index + Indian plate-grammar validation
- [ ] Watchlist service + `WatchlistProvider` interface + MockProvider + seed dataset
- [ ] Alert engine: dedupe, severity, "why" payload; alert queue UI
- [ ] Route reconstruction v1 (sightings → ordered timeline → map polyline)
- [ ] **Gate: give it a plate, get a route and live alerts**

### Day 3 — 6 Sep · differentiators + record own-feed demo
- [ ] OSRM + road graph: observed vs inferred segments, confidence bands
- [ ] Impossible-transition / plate-cloning detection
- [ ] Hash-chained audit log + export bundle with manifest hash
- [ ] Retention / evidence clock
- [ ] Sizing + cost calculator (in-product, live sliders)
- [ ] Gap-analysis report generator → `docs/gap-analysis-sample.md`
- [ ] Video wall (hls.js grid + WHEP single-camera)
- [ ] Prometheus/Grafana health dashboard *(optional)*
- [ ] NL → query compiler *(optional, only if the above is done)*
- [ ] **Record the own-feed demo video (2–3 min)**

### Day 4 — 7 Sep · submit **in the morning**
- [ ] Government-feed demo recording + output report (plates & timestamps, CSV + PDF)
- [ ] Deck covering all 10 dimensions, including "What this system does not do"
- [ ] HLD finalised; diagrams exported
- [ ] `README.md` written for judges; repo made public
- [ ] Cloudflare Tunnel up; test credentials created and verified from a clean browser
- [ ] **Submit by midday.** Never trust a government portal at 23:00 on deadline day.

### Cut order if behind
`re-ID` → `make/model` → `NL query` → `Grafana` → `WHEP` (HLS only) → `Kafka` (Valkey only)

---

## 11. "What this system does not do" — the slide that wins the room

In a room where every vendor is overpromising, the team that states its limits is the one that gets
believed on everything else.

- **No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connection.** Mock provider + a written
  connector specification. We do not claim access we were never given.
- **No face recognition.** Deliberately out of scope: not mandated by the challenge, and it requires
  separate legal authorisation. We process no biometrics.
- **No central video storage.** The architecture refuses it, with the bandwidth arithmetic.
- **No VLM "suspicious activity detection."** Rejected for stated engineering reasons: the cost and
  latency at 80,000 cameras do not survive a procurement review; *"suspicious"* is not a definable
  class, so accuracy cannot be measured and any claim about it is unfalsifiable; and it is
  unauditable — *"the model said it looked suspicious"* is not evidence in court, whereas a plate
  read with a timestamped crop and a confidence score is.
- **No accuracy claims.** We report **measured** precision/recall on the sandbox feeds, including
  where the system fails: night, two-wheelers, oblique angles, motion blur.

---

## 12. Risk register

| Risk | Impact | Mitigation |
|---|---|---|
| **Sandbox feeds have poor plate visibility** | Kills the ANPR demo | Day 0 recon; pivot weighting to Pillars 1/2/4; report honest numbers either way |
| RTSP host blocks datacenter IPs | No cloud GPU | Test Day 0; fall back to local Apple Silicon (MPS) + fewer concurrent cameras |
| Local hardware can't sustain 10+ streams | Thin demo | Motion gating, frame sampling, best-shot-only OCR; state measured throughput and let the sizing model do the scaling argument |
| A Model 5 exists in a document behind the login | Non-compliant submission | Day 0 check + helpdesk call |
| Time — solo, 4 days | Incomplete submission | Strict cut list; Day 1 gate is a *working vertical slice*, not breadth |
| Portal fails at deadline | Total loss | Submit midday 7 Sep, not evening |
| Shortlisted with 2.5 days' travel notice | Miss the finale | Decide travel feasibility **now**, before Day 1 |

---

## 13. Conventions

- Git identity for this repo: `thopatevijay <thopatevijay@gmail.com>`
- Branches: `<type>/<scope>-<description>-<DD-MM-YYYY>`
- Package manager: `npm`
- Secrets in `.env` only, never committed. `.env.example` is committed.
- Deployed endpoints, credentials locations, and camera IDs tracked in `.dev-refs.md`
- TypeScript everywhere on the service/UI side; no `@ts-ignore`

---

## 14. Execution workflow

The 4-day plan is 44 GitHub issues in `.github/plan/`, created by `scripts/bootstrap_github.py`
(idempotent). Full contract in **`WORKFLOW.md`**.

```
/status                →  what is next, rebuilt from GitHub with zero context
/start <TICKET-ID>     →  branch · PRP · implement · verify every AC · gate · PR · merge · close
/gate <GATE-ID>        →  verify a whole day from a clean state before the next begins
/backlog "<finding>"   →  log a bug/gap/pitfall to BL-01 without derailing the ticket in flight
```

State lives in GitHub (issue bodies, labels, and **handoff comments**) and in committed plan files —
never in a conversation. Any new session resumes from `/status`.

Ticket order: **`D0-01` before anything else.** It is the only ticket that can invalidate the
architecture.
