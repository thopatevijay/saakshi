# Claims provenance — every printed number and where it came from

**D4-04 deliverable.** The rule is stated in the ticket: *"every number on every slide is traceable
to a ticket comment. No unsourced figures."* This is that table.

A figure nobody can chase is a figure a scorer is entitled to discount, so each row below carries the
ticket that measured it and, where one exists, the command that reproduces it.

> **Generated figures are not listed individually.** The sizing and cost slides are computed at build
> time by `computeSizing()` — the same model behind the in-product calculator — so their provenance
> is the model's own constants table, each tagged `measured`, `listed` or `assumed`. See
> `docs/sizing-model.md` §7. Rebuild with `npm run deck:build`.

---

## 1 · Estate and registry

| Figure | Value | Source | Reproduce |
|---|---|---|---|
| Departments in scope | 26 | `/problems` (challenge page) | — |
| Estate size | ~80,000 cameras | `/problems` | — |
| Sandbox cameras | 30 | D0-01 (#2) | `GET /cameras.json` |
| Catalogue fields published upstream | `{id, name}` only | D0-01 (#2), BL-01 | `curl …/cameras.json` |
| Distinct resolutions measured | 6 | D0-01 (#2) | `scripts/recon.py` |
| Distinct frame rates measured | 6 | D0-01 (#2) | same |
| Recording-duration spread | 1.0 h – 24.5 h (24×) | D0-01 (#2) | same |
| Sighting spread across two cameras, same city and hour | 67 vs 33,548 (500×) | D1-09 (#13) | analytics run |
| `cam03` decode health while quiet | 5,582 frames, 23.16 fps | D1-09 (#13) | same |

## 2 · ANPR accuracy — identical to `submission/govt-feed-output-report.pdf`

**These six figures must match the output report exactly.** D4-04 AC 6 requires it and D4-03's
handoff states them; `solution-deck.test.ts` asserts the deck constant against the generated CSV so
the two cannot drift silently.

| Figure | Value | Source |
|---|---|---|
| Exact read recall (reads equal to the human label, over legible plates) | **0 of 3 — 0%** | D2-01 (#15), `docs/anpr-accuracy.md` §3 |
| Precision (correct reads over all reads emitted) | **0%** | same |
| Plate-detection recall (plate boxes over human-legible plates) | **100% on n=3** | same |
| Character accuracy (`1 − editDistance/len`) | **51.8%** | same |
| Human-legible plates in the hand-labelled sample | **3 of 120** | same |
| Verdict against the challenge's >90% target | **MISSES** | stated as a miss on slide 19 |

Method: 120 vehicle instances hand-labelled from this estate, day and night sampled separately.
`docs/anpr-accuracy.md` §2 carries the sampling method and §3 the per-condition breakdown.

## 3 · Government-feed output report

| Figure | Value | Source | Reproduce |
|---|---|---|---|
| Plate reads reported | 4 | D4-03 (#38) | `npm run report:anpr-output -- --from … --to …` |
| Cameras producing reads | 2 (`cam04`, `cam05`) | same | same |
| Reads with a stored crop | 4 of 4 | same | same |
| Synthetic rows excluded | 11 (`TRACEFIX-*`) | same | same |
| Cameras with sightings and no read | 3 | same | same |
| Highest-confidence read of the run | `757508300` at **0.888** — a roadside hoarding, not a plate | D2-03, D4-03 | the crop in the report |

## 4 · Performance benchmarks — the six stated targets

| Target | Measured | Verdict | Source | Reproduce |
|---|---|---|---|---|
| 1,00,000+ camera records | 1,00,000 cameras benchmarked | meets | D1-02, `docs/registry-api.md` §11 | `npm run bench:api` |
| API response < 200 ms | p95 **110 ms** at 200 concurrent; **252 ms** at 500 | meets to 200; over at 500 | same | same |
| Dashboard load < 3 s | readable **132 ms**; map fully drawn **1.65 s** | meets | D1-08, `docs/basemap-setup.md` | `verify-map.mjs` |
| Detection accuracy > 90% | exact read recall **0%** | **MISSES** | D2-01 | §2 above |
| Uptime > 99% | **100.000%** over a stable 30 min; **73.5%** over a build hour | **not measured over a meaningful period** | D3-10, `docs/observability.md` §5 | Prometheus |
| 500+ concurrent users | **500 concurrent, zero failed responses** | meets on throughput; p95 over target | D1-02 | `npm run bench:api` |

Two of the six are misses and one is unmeasured. All three appear on slide 19 rather than being
dropped.

## 5 · Coverage and the road graph

| Figure | Value | Source | Reproduce |
|---|---|---|---|
| Road network | **540,711 ways · 218,137.5 km** | D3-01 / D4-10 (#89) | `./scripts/import-osm.sh` |
| Extract provenance | Geofabrik western-zone clipped to Gujarat `68.0,19.9,74.6,24.8`, **OSM data of 2026-09-05T20:22:06Z** | D4-10 | recorded in the report |
| All-camera coverage | **21.47 km** (0.0098% of the network) | D3-06 / D4-10 | `npm run report:gap-analysis` |
| ANPR-viable coverage | **2.77 km** (0.0013%) | same | same |
| **Trusted-only coverage** | **0.00 km** — a 100% delta | same | same |
| Junctions with zero trusted coverage | **6,750 of 6,750** | same | same |
| Reconciliation error | 0.000000 m (tolerance 1 m) | same | same |

## 6 · Backhaul arithmetic

| Figure | Value | Source |
|---|---|---|
| Every camera streamed centrally, 80,000 cameras | **160.00 Gbps** | PROJECT.md §9, reproduced by `computeSizing()` |
| Metadata from edge-analysed cameras | **1.28 Gbps** | same |
| **Reduction quoted** | **125×** | same — `docs/sizing-model.md` §6 lists it as *reproduced* |
| Reduction on our measured per-track event rate | 2,848× | `computeSizing()` on the `statewide` preset |

**We quote 125×, the smaller figure**, because it runs on the original assumed 2,000 B/s event rate
and therefore reproduces a published section a reader can check. The measured rate makes the
architecture look better, not worse.

## 7 · Differentiators

| Figure | Value | Source |
|---|---|---|
| Cloned-plate example | 9.24 km apart, 30 s apart → **1,109 km/h required** | D3-02, `demo:trace --clone` |
| Impossible transitions found in the sweep | **2 of 7 assessable (28.6%)** — flagged by the tool itself as implausibly high for genuine cloning | D3-02 / D4-10 | 
| Vehicle re-ID held-out precision | **0.761** against a 0.9 bar — **ships disabled** | D3-03, `docs/reid.md` |
| Fuzzy matcher knee | `max_distance` 2.0 — 99.9% recall, 100% precision at d≤2 | D2-04, `docs/fuzzy-matching.md` §6 |
| Retention window on this estate | 7–15 days | `/problems`, D3-05 |
| Alert verdict round trip | **132 ms** | D2-07 |
| Route build, 20-sighting trace | **125 ms** p95 (budget 3,000 ms) | D3-01, `docs/route-reconstruction.md` |

## 8 · What is deliberately absent

These are not figures; they are the claims we do **not** make, and they are on slide 20 verbatim from
`PROJECT.md` §11.

- No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connection — mock provider plus a written connector
  specification.
- No face recognition. No biometrics processed.
- No central video storage — the architecture refuses it, and §6 above is the arithmetic.
- No VLM "suspicious activity detection" — unfalsifiable, unauditable, and not affordable at
  80,000 cameras.
- No accuracy claim without a measurement.

---

## How to check this document

```bash
npm run deck:build                 # regenerates the deck from the model
npm run report:anpr-output -- --from 2026-09-11T00:00:00Z --to 2026-09-12T00:00:00Z
npm run report:gap-analysis
npm run test -w @saakshi/api -- solution-deck    # asserts deck accuracy == report accuracy
```

If a number on a slide is not in this table, it is a defect in the deck, not a shortcut in this
document.
