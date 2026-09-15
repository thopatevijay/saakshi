/**
 * `npm run docs:render` — `docs/HLD.md` and `submission/saakshi-hld.pdf` (D4-05).
 *
 * **Mandatory submission item 2**, scored as evaluation area #3, "Solution Architecture". The
 * problem statement lists exactly what an HLD must cover, and that list is the specification: every
 * bullet gets a section whose heading names it, so a scorer can tick down the page.
 *
 * ## Why this is generated
 *
 * AC 3 requires the sizing and scalability sections to come from `docs/sizing-model.md` rather than
 * be hand-typed, and D4-04's handoff requires the HLD not to contradict the deck. Both are the same
 * problem — two documents printing the same fact from two sources drift the moment either changes —
 * and both have the same answer: the figures come from `computeSizing()` and from `MEASURED_ANPR`,
 * the exact symbols the deck reads. `hld.test.ts` asserts it, so the two cannot diverge silently.
 *
 * Prose that is not a number is authored here. This is a document with an argument, not a report.
 */
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeSizing,
  presetById,
  formatInrBand,
  SECTION_9_REPRODUCTION,
  type SizingResult,
} from '@saakshi/shared';
import { MEASURED_ANPR } from '../services/anpr-accuracy.js';

/** See `gap-analysis-cli.ts`: a job writing a deliverable resolves against the repo, never cwd. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * The problem statement's HLD content list, verbatim, paired with the section that answers it.
 *
 * This array *is* AC 1. It generates both the checklist a scorer reads and the section headings, so
 * a heading cannot drift from the requirement it claims to satisfy — they are one string.
 */
export const HLD_REQUIREMENTS: ReadonlyArray<{ id: string; requirement: string; heading: string }> =
  [
    {
      id: 'R1',
      requirement:
        'Overall solution architecture with high-level diagrams and component interactions',
      heading: 'Overall solution architecture, with high-level diagrams and component interactions',
    },
    {
      id: 'R2',
      requirement:
        'Approach for integrating heterogeneous cameras, NVRs and VMS into a unified platform (IP, analog, multi-vendor, varied protocols)',
      heading:
        'Approach for integrating heterogeneous cameras, NVRs and VMS into a unified platform',
    },
    {
      id: 'R3',
      requirement:
        'Architecture for ingesting, processing and managing live streams from geographically dispersed locations',
      heading:
        'Architecture for ingesting, processing and managing live streams from geographically dispersed locations',
    },
    {
      id: 'R4',
      requirement:
        'Approach for integrating live feeds with watchlist databases and continuously correlating analytics results to generate real-time alerts',
      heading:
        'Approach for integrating live feeds with watchlist databases, and continuously correlating analytics to generate real-time alerts',
    },
    {
      id: 'R5',
      requirement:
        'AI-powered analytics approach: ANPR (mandatory), object detection, person/vehicle tracking',
      heading: 'AI-powered analytics approach: ANPR, object detection, and vehicle tracking',
    },
    {
      id: 'R6',
      requirement:
        'Alert generation and notification workflow: prioritisation, visualisation, user interaction',
      heading:
        'Alert generation and notification workflow: prioritisation, visualisation, user interaction',
    },
    {
      id: 'R7',
      requirement:
        'Scalability, interoperability, security and performance for statewide deployment',
      heading: 'Scalability, interoperability, security and performance for statewide deployment',
    },
    {
      id: 'R8',
      requirement:
        'Technical prerequisites, assumptions, and information required from participating departments',
      heading:
        'Technical prerequisites, and the information required from participating departments',
    },
    {
      id: 'R9',
      requirement: 'Assumptions and constraints',
      heading: 'Assumptions and constraints',
    },
  ];

export const DIAGRAMS: ReadonlyArray<{ file: string; caption: string }> = [
  { file: '01-system-context.png', caption: 'Figure 1 — System context: sources, edge, core, console.' },
  { file: '02-edge-district-node.png', caption: 'Figure 2 — Inside one edge / district node.' },
  { file: '03-data-flow.png', caption: 'Figure 3 — Data flow: frame to sighting to alert to evidence.' },
  { file: '04-deployment-topology.png', caption: 'Figure 4 — Deployment topology for statewide operation.' },
  { file: '05-trust-score-pipeline.png', caption: 'Figure 5 — The trust-score pipeline.' },
  { file: '06-audit-chain.png', caption: 'Figure 6 — The tamper-evident audit chain and export bundle.' },
];

const gbps = (v: number): string => `${v.toFixed(2)} Gbps`;
const inr = (band: { low: number; high: number }): string => formatInrBand(band);

function preset(id: string): SizingResult {
  const found = presetById(id);
  // `presetById` is optional-returning, and the honest response to a missing preset is to stop: an
  // HLD with a blank sizing table is worse than no build.
  if (found === undefined) throw new Error(`sizing preset "${id}" not found`);
  return computeSizing(found.inputs);
}

export interface HldFigures {
  pilot: SizingResult;
  statewide: SizingResult;
  benchmark: SizingResult;
  section9: SizingResult;
}

export function hldFigures(): HldFigures {
  return {
    pilot: preset('pilot'),
    statewide: preset('statewide'),
    benchmark: preset('benchmark'),
    section9: computeSizing(SECTION_9_REPRODUCTION.inputs, SECTION_9_REPRODUCTION.overrides),
  };
}

/** The whole document. */
export function hldMarkdown(f: HldFigures = hldFigures()): string {
  const { pilot, statewide, benchmark, section9 } = f;
  const s = (i: number): string => HLD_REQUIREMENTS[i]?.heading ?? '';

  const out: string[] = [];
  const w = (...lines: string[]): void => {
    out.push(...lines);
  };

  w(
    '# SAAKSHI — High-Level Design',
    '',
    '**Technical proposal for the Gujarat Police Innovation Challenge 2026.**',
    'Submitted under **Model 1 (compulsory) + Hybrid**, as sanctioned by the problem statement’s',
    'explicit permission for *“a hybrid architecture combining features from two or more reference',
    'solution models”*.',
    '',
    '> **Every number in this document is traceable.** `docs/claims-provenance.md` lists each printed',
    '> figure against the ticket that measured it and the command that reproduces it. The sizing and',
    '> cost tables here are **computed at build time** by the same `computeSizing()` model that runs',
    '> behind the console’s `/sizing` screen, so this document and the product cannot disagree.',
    '> Rebuild with `npm run docs:render`.',
    '',
    '---',
    '',
    '## What this document is, and what it refuses to claim',
    '',
    'A statewide CCTV analytics platform is easy to describe and hard to believe. In a field where',
    'every proposal promises 95% accuracy and seamless integration with systems the proposer has',
    'never been given access to, the only useful thing a design document can do is be **checkable**.',
    '',
    'So this HLD states, up front, the five things SAAKSHI does **not** do:',
    '',
    '- **No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connection.** The connectors are specified',
    '  and a mock provider ships behind the same interface. We do not claim access we were never given.',
    '- **No face recognition, and no biometrics of any kind are processed or stored.** Deliberate, and',
    '  the reasoning is in §5.',
    '- **No central video storage.** The architecture refuses it, and §3 is the arithmetic for why.',
    '- **No VLM “suspicious activity detection.”** Unfalsifiable, unauditable, and unaffordable at',
    '  80,000 cameras. §5 gives all three reasons.',
    `- **No accuracy claim without a measurement.** Our measured ANPR read accuracy **${MEASURED_ANPR.verdictAgainstTarget.replace('MISSES the challenge’s', 'misses the challenge’s')}**. That figure is printed in §5, on the`,
    '  deck, and in the government-feed output report, identically, because a system that hides the',
    '  row it fails cannot be trusted on the rows it passes.',
    '',
    'Everything that follows is designed to be re-run by a sceptical reader.',
    '',
    '---',
    '',
    '## Requirement checklist',
    '',
    'The problem statement lists what the High-Level Design must cover. Each row names the section',
    'that answers it.',
    '',
    '| # | Required content | Section |',
    '|---|---|---|',
  );
  HLD_REQUIREMENTS.forEach((r, i) => {
    w(`| ${r.id} | ${r.requirement} | §${String(i + 1)} |`);
  });
  w('', '---', '');

  // ── §1 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 1. ${s(0)}`,
    '',
    'SAAKSHI is a **metadata platform, not a video platform**. Cameras stay where they are, owned by',
    'the department that owns them; video stays inside the district it was captured in; and what',
    'crosses the state network is a stream of structured events a few hundred bytes wide. Every',
    'architectural decision below follows from that one choice, and §3 shows the arithmetic that',
    'forces it.',
    '',
    `![System context](architecture/${DIAGRAMS[0]?.file ?? ''})`,
    '',
    `*${DIAGRAMS[0]?.caption ?? ''}*`,
    '',
    '### The four layers, and what each is responsible for',
    '',
    '| Layer | Responsibility | Technology | Scales by |',
    '|---|---|---|---|',
    '| **Sources** | Nothing. Unchanged, unmanaged by us, still owned by the department | Existing IP, analog+DVR, vendor VMS | — |',
    '| **Edge / district node** | Decode, detect, track, read plates, probe health. Emit events, never video | Python 3.11, OpenCV, YOLO11, ByteTrack, ONNX OCR, MediaMTX | One node per district; streams per node |',
    '| **State core** | Durable state, correlation, alerting, evidence, audit | PostgreSQL 16 + PostGIS + TimescaleDB, Valkey Streams, MinIO | Read replicas, consumer groups, erasure coding |',
    '| **Service + console** | API surface and the operator’s day | Fastify (TypeScript strict), Next.js 15, MapLibre | Stateless replicas behind a load balancer |',
    '',
    '### Component interactions that matter',
    '',
    '- **Adapter → gateway → analytics.** The adapter normalises a heterogeneous source into one',
    '  internal stream contract (§2). Nothing downstream of the adapter knows what vendor it came from.',
    '- **Analytics → event bus.** The worker writes sightings, plate reads and health observations to',
    '  Valkey Streams. It never writes to the database, so a slow database cannot stall a decoder.',
    '- **Bus → API.** Consumer groups give at-least-once delivery with replay; a district that loses',
    '  backhaul buffers locally and drains on reconnect rather than losing the window.',
    '- **API → console.** REST plus server-sent events. The alert queue is pushed, not polled.',
    '- **Evidence is never public.** A crop reaches a browser as a same-origin relative path,',
    '  `/evidence/crop?uri=…`, streamed by the API behind the session cookie and a role check. The',
    '  object store has no public domain and hands out no shareable link.',
    '',
    `![Edge node](architecture/${DIAGRAMS[1]?.file ?? ''})`,
    '',
    `*${DIAGRAMS[1]?.caption ?? ''}*`,
    '',
    `![Data flow](architecture/${DIAGRAMS[2]?.file ?? ''})`,
    '',
    `*${DIAGRAMS[2]?.caption ?? ''}*`,
    '',
  );

  // ── §2 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 2. ${s(1)}`,
    '',
    'Gujarat’s estate is not one system. It is ~80,000 cameras across **26 departments**, bought over',
    'a decade, under live AMCs, in a mix of IP and analog, behind at least four vendor VMS products.',
    'Any design that requires those departments to replace, re-cable or surrender their equipment is',
    'a design that will not be deployed, whatever its merits.',
    '',
    '**So SAAKSHI integrates at the protocol boundary and asks for nothing else.** Full detail:',
    '[`docs/adapter-framework.md`](adapter-framework.md).',
    '',
    '### The adapter contract',
    '',
    'Every source type is a driver behind one interface — `probe()`, `open()`, `frames()`, `close()` —',
    'returning the same normalised stream regardless of origin.',
    '',
    '| Source | How it is reached | Notes |',
    '|---|---|---|',
    '| IP camera | RTSP, **forced over TCP** | UDP loses packets on a congested WAN and produces corrupt frames that look like analytics failures |',
    '| IP camera, discoverable | ONVIF Profile S | Device and media service; capabilities read, never assumed |',
    '| Analog camera | Existing DVR/encoder’s RTSP or HLS output | No re-cabling: the encoder the department already owns is the integration point |',
    '| Vendor VMS / NVR | Vendor SDK or the VMS’s own RTSP re-stream | Re-stream preferred — an SDK is a procurement dependency, a re-stream is not |',
    '| Low-latency web | WHEP / WebRTC | Used by the console’s video wall |',
    '| Recorded / VOD | HLS | The challenge sandbox itself is VOD HLS |',
    '',
    '### Three rules learned the hard way, and they are in the code',
    '',
    '1. **Timing comes from PTS, never from frame arrival time.** A gateway that replays a buffered',
    '   GOP on connect makes an arrival-time tracker compute impossible velocities after every',
    '   reconnect — which then surface as false “impossible transition” alerts. Presentation',
    '   timestamps are the only defensible clock.',
    '2. **Never trust declared FPS.** `CAP_PROP_FPS` is what the device claims. We measure the real',
    '   rate and store both, and **the delta is a product feature**: a camera declaring 25 fps and',
    '   delivering 4 is a camera whose evidentiary value is a quarter of what the register says.',
    '3. **Reconnect with backoff, 2 s → 30 s, and treat join-time decoder warnings as normal.** A',
    '   tight reconnect loop against a struggling NVR takes down the NVR, and then the department.',
    '',
    '### Interoperability, stated as obligations we accept rather than features we claim',
    '',
    '- Adding a vendor is **one driver class**, not a schema change or a redeployment.',
    '- The registry API is OpenAPI-documented ([`docs/registry-api.md`](registry-api.md)) so a',
    '  department can bulk-register its own estate without us.',
    '- Everything in the stack is open source, which the challenge’s About page states solutions',
    '  *should* use. The single proprietary option — the natural-language query LLM — sits behind a',
    '  `QueryCompiler` interface with four providers, one of which is local `ollama` and one of which',
    '  is `none`. **Nothing proprietary is load-bearing.**',
    '',
  );

  // ── §3 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 3. ${s(2)}`,
    '',
    '### The arithmetic that decides the architecture',
    '',
    'This is the central engineering claim of the submission, and it is checkable in one line.',
    '',
    '| | |',
    '|---|---|',
    `| Every camera streamed to a central VMS — 80,000 × 2 Mbps | **${gbps(section9.backhaul.allCentralVideoGbps)}** |`,
    `| Metadata only, from cameras analysed at the edge | **${gbps(section9.backhaul.metadataBackhaulGbps)}** |`,
    `| Total under this architecture | **${gbps(section9.backhaul.totalBackhaulGbps)}** |`,
    `| **Reduction** | **${section9.backhaul.reductionRatio.toFixed(0)}×** |`,
    '',
    `**We quote ${section9.backhaul.reductionRatio.toFixed(0)}×, which is the smaller of two defensible numbers.** It runs on the original`,
    'assumed 2,000 B/s event rate and therefore reproduces `PROJECT.md` §9 exactly, so a reader can',
    `check it against a published section. Our *measured* per-track event rate takes the same estate to`,
    `${statewide.backhaul.reductionRatio.toFixed(0)}×. The measured rate makes the architecture look better, not worse, and we lead with`,
    'the figure that can be verified rather than the figure that flatters.',
    '',
    '160 Gbps of sustained ingest is not a budget line; it is a reason a project fails. That is why a',
    'fully centralised VMS — Model 4 as `/problems` describes it — is rejected in this document with',
    'its arithmetic attached.',
    '',
    '### Managing streams across geographically dispersed locations',
    '',
    '| Concern | Design response |',
    '|---|---|',
    '| **Unreliable district links** | The node buffers locally and drains on reconnect. A backhaul outage delays events; it does not lose them |',
    '| **Bandwidth asymmetry** | Only events cross the WAN. A crop is a few kilobytes and only for a best shot |',
    '| **Clock skew across districts** | PTS-derived event time plus server receipt time, both stored. Correlation uses the former |',
    '| **Feeds that loop or cut** | A hard scene cut is normal in this estate. Track IDs and galleries reset at a cut rather than bleeding across it — otherwise one vehicle inherits another’s route |',
    '| **Node loss** | District nodes are stateless between events. A replacement node re-registers and resumes; nothing is pinned to a machine |',
    '| **Central saturation** | Consumer groups scale horizontally; the database takes writes in batches, and TimescaleDB partitions the sighting hypertable by time |',
    '',
    `![Deployment topology](architecture/${DIAGRAMS[3]?.file ?? ''})`,
    '',
    `*${DIAGRAMS[3]?.caption ?? ''}*`,
    '',
    '### Edge versus centralised — the decision, stated plainly',
    '',
    `**Analytics at the edge, state at the centre.** Detection, tracking and plate reading run on the`,
    `district node; correlation, watchlists, alerting, evidence and audit run centrally. Video never`,
    `leaves the district. This is the only split that survives the ${gbps(section9.backhaul.allCentralVideoGbps)} figure above, and it`,
    'is also the split that keeps a department’s footage under that department’s control — which is',
    'what makes 26 departments willing to participate at all.',
    '',
  );

  // ── §4 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 4. ${s(3)}`,
    '',
    '### What is built, and what is specified — the distinction is the point',
    '',
    '> **There is no live VAHAN, SARTHI, eGujCop, AFIS or NAFIS connectivity in this submission, and',
    '> this document never implies otherwise.** We were not granted access to those systems, and a',
    '> demonstration against a system we cannot reach would be a fabrication.',
    '',
    'What exists instead is the part that is actually ours to build: a **watchlist service behind a',
    'provider interface**, with a mock provider that implements it, a documented connector',
    'specification for each government system, and the correlation engine — which is real, running,',
    'and indifferent to where the watchlist rows came from. Swapping the mock for a live VAHAN client',
    'is one class implementing one interface. Full detail:',
    '[`docs/watchlist-integration.md`](watchlist-integration.md).',
    '',
    '| Watchlist category named in the problem statement | Supported | Source when live |',
    '|---|---|---|',
    '| Stolen vehicles | Yes, by registration number | VAHAN / state stolen-vehicle register |',
    '| Blacklisted vehicles | Yes | Department-maintained list, bulk-loaded |',
    '| Suspect watchlists (vehicle-linked) | Yes | eGujCop case linkage |',
    '| Wanted persons | **Vehicle-linked only** | Correlated through a registered vehicle, never by face |',
    '| Missing persons | **Vehicle-linked only** | Same |',
    '',
    '**Wanted and missing persons are matched through vehicles, not through faces.** That is a real',
    'limitation and we state it rather than let a category tick imply a capability. See §5.',
    '',
    '### Continuous correlation',
    '',
    'Every plate read is correlated as it lands, not on a batch schedule:',
    '',
    '1. **Normalise.** The read is folded to a canonical form on the write path, so the string that',
    '   alerts is the same string a trace later searches.',
    '2. **Exact match** against the active watchlist.',
    '3. **Confusion-aware fuzzy match** if exact fails. Indian plates confuse a specific, known set of',
    '   character pairs under motion blur and at night, and the matcher is weighted for those pairs',
    '   rather than using a generic edit distance. The operating point is `max_distance` **2.0** —',
    '   measured at **99.9% recall and 100% precision** at d ≤ 2 ([`docs/fuzzy-matching.md`](fuzzy-matching.md) §6).',
    '4. **Emit an alert** with a severity and a dedupe key, or retain the sighting for trace and the',
    '   retention clock only.',
    '',
    'Fuzzy matching is the single highest-leverage feature in the system on this estate, because on',
    'this estate most plates are not read cleanly. A matcher that only accepts exact strings converts',
    'a marginal read into a miss.',
    '',
  );

  // ── §5 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 5. ${s(4)}`,
    '',
    '### ANPR — the only mandatory analytic, and our measured numbers',
    '',
    'Pipeline: motion gate → YOLO11 detection → ByteTrack tracking → best-shot selection → ONNX plate',
    'OCR → plate-grammar normalisation → watchlist correlation. Best-shot selection is what makes it',
    'affordable: OCR runs on the single best frame of a track, not on every frame of it, and the',
    'measured keep rate is **33 crops per 1,000 sightings**.',
    '',
    '**The measurement, on this estate, day and night sampled separately** — 120 vehicle instances',
    'hand-labelled, method in [`docs/anpr-accuracy.md`](anpr-accuracy.md) §2–3:',
    '',
    '| Metric | Measured |',
    '|---|---|',
    `| Exact read recall (reads equal to the human label, over legible plates) | **${MEASURED_ANPR.exactReadRecall}** |`,
    `| Precision (correct reads over all reads emitted) | **${MEASURED_ANPR.precision}** |`,
    `| Plate-detection recall (plate boxes over human-legible plates) | **${MEASURED_ANPR.plateDetectionRecall}** |`,
    `| Character accuracy (1 − editDistance/len) | **${MEASURED_ANPR.characterAccuracy}** |`,
    `| Human-legible plates in the hand-labelled sample | **${MEASURED_ANPR.legiblePlates}** |`,
    `| Against the challenge’s >90% target | **${MEASURED_ANPR.verdictAgainstTarget}** |`,
    '',
    '**Why, and why it is reported rather than buried.** Of 120 hand-labelled vehicle instances on the',
    'sandbox estate, **three carry a plate a human can read at all**. The cameras are mounted for',
    'scene overview, not for plate capture: wrong height, wrong angle, wrong focal length, and at',
    'night a measured luma floor that leaves no plate signal to recover. The highest-confidence read',
    'of the government-feed run — **0.888** — is a roadside hoarding’s phone number, not a plate.',
    '',
    'This is the most important number in the submission, and it is a failure. It is also a **camera',
    'placement finding, not a model finding**, which is precisely the finding a statewide gap analysis',
    'exists to produce: the system correctly reports that this estate cannot do ANPR, and identifies',
    `the **${statewide.compute.anprCameras.toLocaleString('en-IN')} cameras** in the statewide model that would need to be ANPR-viable for it to.`,
    'A vendor claiming 95% on these feeds is claiming something the feeds cannot physically support.',
    '',
    '### The other analytics',
    '',
    '| Analytic | Status | Honest position |',
    '|---|---|---|',
    '| Object detection (vehicle, person, two-wheeler) | **Running** | YOLO11; the detector is the reliable half of the pipeline |',
    '| Multi-object tracking | **Running** | ByteTrack. **Measured caveat: 16 of 75 tracked passes (21%) do not hold a single vehicle** — 9 identity switches, 7 unadjudicable. Anything treating one track as one vehicle inherits that rate |',
    '| Camera trust scoring | **Running** | Classical CV, deterministic and explainable. §7 and Figure 5 |',
    '| Route reconstruction | **Running** | OSRM over a 540,711-way Gujarat road graph; 20-sighting trace builds in **125 ms** p95 against a 3,000 ms budget |',
    '| Impossible-transition / plate-cloning detection | **Running** | A worked example: two reads 9.24 km and 30 s apart imply **1,109 km/h** |',
    '| Vehicle re-identification | **Built, measured at 0.761 precision, ships DISABLED** | Below the 0.900 bar. Roughly one appearance link in four would be wrong, and a wrong link attaches another vehicle’s movements to this vehicle’s evidentiary route. Off in three independent places ([`docs/limitations.md`](limitations.md)) |',
    '| **Face recognition** | **Deliberately out of scope** | See below |',
    '',
    '### Face recognition is deliberately out of scope',
    '',
    '**SAAKSHI processes no biometrics and stores no biometric template.** Three reasons, in order of',
    'weight:',
    '',
    '1. **It is not mandated.** ANPR is the only analytic the challenge makes compulsory. FRS is not',
    '   asked for, so shipping it would be scope we awarded ourselves.',
    '2. **It requires separate legal authorisation.** Face recognition against a public estate is a',
    '   different legal instrument from vehicle analytics, with a different authority, a different',
    '   retention regime and a different consent position. A hackathon submission is not the venue to',
    '   assume that authorisation exists.',
    '3. **It would poison the evidentiary argument.** This system’s value is that every output is',
    '   auditable: a plate read carries a timestamped crop, a confidence, and a hash-chained record of',
    '   who looked at it and why. A face match carries the same weight in a courtroom as *“the model',
    '   said so”*, and mixing the two lowers the standard of the whole platform.',
    '',
    'The same reasoning rejects **VLM-based “suspicious activity detection”**: *suspicious* is not a',
    'definable class, so accuracy cannot be measured and any claim about it is unfalsifiable; it is',
    'unauditable as evidence; and the inference cost and latency at 80,000 cameras do not survive a',
    'procurement review.',
    '',
  );

  // ── §6 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 6. ${s(5)}`,
    '',
    'A control room does not fail because it has too few alerts. It fails because it has too many, and',
    'the operator stops reading them. The alert design is built around that failure mode. Full detail:',
    '[`docs/alerting.md`](alerting.md).',
    '',
    '### Prioritisation',
    '',
    '| Mechanism | What it does |',
    '|---|---|',
    '| **Severity** | Derived from the watchlist category and match confidence, not from the analytic that fired |',
    '| **Deduplication key** | One vehicle passing one camera repeatedly is **one** alert with a count, not forty |',
    '| **Match-type banding** | An exact match and a fuzzy match at d=2 are visibly different things in the queue; the operator is never asked to guess which they are looking at |',
    '| **Camera trust weighting** | An alert from a camera the trust prober scores poorly is presented as weaker evidence, because it *is* weaker evidence |',
    '',
    '### Visualisation and interaction',
    '',
    '- **The alert queue is pushed over SSE**, not polled; a verdict round trip measured at **132 ms**.',
    '- Every alert opens with **the crop that caused it**, the camera, the PTS-derived time, the',
    '  confidence, and the matched watchlist entry. An alert a human cannot adjudicate in five seconds',
    '  is an alert that will not be adjudicated.',
    '- **The operator’s verdict is the product.** True positive / false positive is one click, it is',
    '  recorded against the alert, and it appends to the audit chain. That verdict stream is what',
    '  makes measured precision possible at all — without it, nobody knows what the system is doing.',
    '- **Escalation to a trace.** From an alert, one click reconstructs the vehicle’s route across the',
    '  estate, with each sighting’s evidence and its confidence shown rather than smoothed away.',
    '- **Export.** An evidence bundle embeds the crop **bytes**, a `manifest.json` with a SHA-256 per',
    '  file, and is independently re-verifiable with `npm run export:verify`.',
    '',
    `![Audit chain](architecture/${DIAGRAMS[5]?.file ?? ''})`,
    '',
    `*${DIAGRAMS[5]?.caption ?? ''}*`,
    '',
  );

  // ── §7 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 7. ${s(6)}`,
    '',
    '### Sizing — computed, not asserted',
    '',
    '> The two figures the challenge publishes disagree: `/problems` says **~80,000 cameras**, and',
    '> `/evaluation-criteria` says **1,00,000+ records/endpoints**. **We design to the higher figure**',
    '> and state both sources. The benchmark column below is the 1,00,000-camera case.',
    '',
    'Every cell is produced at build time by `computeSizing()` — the model behind the console’s',
    '`/sizing` screen — from constants each tagged *measured*, *vendor-listed* or *assumed* in',
    '[`docs/sizing-model.md`](sizing-model.md) §6.',
    '',
    '| | Pilot (500) | Statewide (80,000) | Benchmark (1,00,000) |',
    '|---|---|---|---|',
    `| ANPR cameras | ${pilot.compute.anprCameras.toLocaleString('en-IN')} | ${statewide.compute.anprCameras.toLocaleString('en-IN')} | ${benchmark.compute.anprCameras.toLocaleString('en-IN')} |`,
    `| Accelerators required | ${String(pilot.compute.acceleratorsRequired)} | ${String(statewide.compute.acceleratorsRequired)} | ${String(benchmark.compute.acceleratorsRequired)} |`,
    `| District nodes | ${String(pilot.compute.districtNodes)} | ${String(statewide.compute.districtNodes)} | ${String(benchmark.compute.districtNodes)} |`,
    `| Events per day | ${pilot.storage.eventsPerDay.toLocaleString('en-IN')} | ${statewide.storage.eventsPerDay.toLocaleString('en-IN')} | ${benchmark.storage.eventsPerDay.toLocaleString('en-IN')} |`,
    `| Retained storage | ${pilot.storage.totalRetainedTB.low.toFixed(0)}–${pilot.storage.totalRetainedTB.high.toFixed(0)} TB | ${statewide.storage.totalRetainedTB.low.toFixed(0)}–${statewide.storage.totalRetainedTB.high.toFixed(0)} TB | ${benchmark.storage.totalRetainedTB.low.toFixed(0)}–${benchmark.storage.totalRetainedTB.high.toFixed(0)} TB |`,
    `| Total backhaul | ${gbps(pilot.backhaul.totalBackhaulGbps)} | ${gbps(statewide.backhaul.totalBackhaulGbps)} | ${gbps(benchmark.backhaul.totalBackhaulGbps)} |`,
    `| Capex | ${inr(pilot.cost.capexInr)} | ${inr(statewide.cost.capexInr)} | ${inr(benchmark.cost.capexInr)} |`,
    `| Annual opex | ${inr(pilot.cost.annualOpexInr)} | ${inr(statewide.cost.annualOpexInr)} | ${inr(benchmark.cost.annualOpexInr)} |`,
    `| Annual cost per camera | ${inr(pilot.cost.annualCostPerCameraInr)} | ${inr(statewide.cost.annualCostPerCameraInr)} | ${inr(benchmark.cost.annualCostPerCameraInr)} |`,
    '',
    'Costs are **bands, not points**, everywhere. A crop size measured on small replay frames is',
    'honestly 3–15 KB per crop until one live-feed measurement narrows it, and a model that hid that',
    'uncertainty behind a single number would be lying with more decimal places.',
    '',
    '### Performance — the six stated benchmarks, measured',
    '',
    '**Two of the six are misses and one is not meaningfully measured. All three are printed here.**',
    '',
    '| Target | Measured | Verdict |',
    '|---|---|---|',
    '| 1,00,000+ camera records | 1,00,000 cameras benchmarked | **Meets** |',
    '| API response < 200 ms | p95 **110 ms** at 200 concurrent; **252 ms** at 500 | **Meets to 200 concurrent; over target at 500** |',
    '| Dashboard load < 3 s | readable **132 ms**; map fully drawn **1.65 s** | **Meets** |',
    `| Detection accuracy > 90% | exact read recall **${MEASURED_ANPR.precision}** | **MISSES** |`,
    '| Uptime > 99% | **100.000%** over a stable 30 min; **73.5%** over a build hour | **Not measured over a meaningful period** |',
    '| 500+ concurrent users | **500 concurrent, zero failed responses** | **Meets on throughput; p95 over target** |',
    '',
    '### Security and access control',
    '',
    '| Control | Implementation |',
    '|---|---|',
    '| **Authentication** | Badge + password to the web BFF, which holds an httpOnly session cookie. The browser never holds a bearer token |',
    '| **Authorisation** | Role matrix — administrator, supervisor, operator, auditor — enforced at the route, not in the UI ([`docs/rbac.md`](rbac.md)) |',
    '| **Purpose binding** | A sensitive query declares *why*, and the declared purpose is recorded with the query. A search with no stated purpose is refused |',
    '| **Evidence access** | Crops stream through the API behind session and role. The object store has no public domain, and a crop URL is not shareable — it requires a live session, which is the point |',
    '| **Tamper-evident audit** | Hash-chained log, each entry over the previous hash. `npm run audit:verify` recomputes the whole chain and names the row it breaks at |',
    '| **Export integrity** | Bundle manifest with SHA-256 per file, re-verifiable independently |',
    '| **Retention** | An evidence clock per record; the retention window on this estate is 7–15 days and expiry is enforced, not advisory |',
    '| **Transport** | TLS at the edge of the state network; district → core over mTLS |',
    '',
    `![Trust-score pipeline](architecture/${DIAGRAMS[4]?.file ?? ''})`,
    '',
    `*${DIAGRAMS[4]?.caption ?? ''}*`,
    '',
    '### Registry completeness — the differentiator, and a number nobody enjoys printing',
    '',
    'A registry that lists cameras is a spreadsheet. A registry that states which cameras can be',
    '**relied on** is infrastructure. The trust prober measures reachability, real versus declared FPS,',
    'blur, night usability, tamper and PTS continuity, and the gap analysis then asks the only',
    'question that matters operationally: *how much of Gujarat’s road network is actually covered by a',
    'camera you would take to court?*',
    '',
    '| | |',
    '|---|---|',
    '| Road network analysed | **540,711 ways · 218,137.5 km** (Geofabrik western zone clipped to Gujarat, OSM data 2026-09-05) |',
    '| Covered by **any** camera | **21.47 km** — 0.0098% |',
    '| Covered by an **ANPR-viable** camera | **2.77 km** — 0.0013% |',
    '| Covered by a **trusted** camera | **0.00 km** |',
    '| Junctions with zero trusted coverage | **6,750 of 6,750** |',
    '',
    '**The trusted-only figure is 0.00 km, a 100% delta against apparent coverage.** On the sandbox',
    'estate, no camera clears the trust bar. That is the finding. A procurement officer holding this',
    'report knows exactly which cameras to fix first and why — which is worth considerably more than a',
    'dashboard that reports 30 cameras online and stops there.',
    '',
  );

  // ── §8 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 8. ${s(7)}`,
    '',
    'Deployment is blocked by information, not by engineering. This section is the ask, so a',
    'participating department can answer it before a single node is racked.',
    '',
    '### Technical prerequisites',
    '',
    '| Prerequisite | Why it is needed | If it is absent |',
    '|---|---|---|',
    '| One node per district: GPU or equivalent accelerator, per the §7 sizing | Analytics run at the edge | Fewer concurrent ANPR streams per district; the model computes the trade directly |',
    '| Network reachability from that node to each camera or NVR, RTSP/TCP | Ingest | Per-camera exclusion, recorded in the registry rather than silently skipped |',
    '| WAN link, district → state core, sized from §7’s metadata figure | Event backhaul | Local buffering absorbs outages; sustained under-provision delays alerts |',
    '| Outbound TLS/mTLS from district to core | Transport security | Deployment blocked |',
    '| A camera location for every camera — latitude and longitude | GIS mapping and gap analysis are **compulsory Model 1 deliverables** | A camera with no coordinates is `unassessable` and is reported as such, never quietly dropped |',
    '| NTP on every node | Cross-camera correlation | Skew produces false impossible-transition alerts |',
    '',
    '### Information required from participating departments',
    '',
    '| # | What we need | Why |',
    '|---|---|---|',
    '| 1 | Camera inventory: id, site name, **lat/long**, mounting height, view direction | The registry and every spatial output depend on it |',
    '| 2 | Stream endpoints and protocol per camera (RTSP/ONVIF/HLS), and credentials | Ingest |',
    '| 3 | VMS/NVR make, model and version where a VMS is in front of the cameras | Selects the adapter driver |',
    '| 4 | Which cameras are **intended** for plate capture | Sets the ANPR-viability baseline against what we measure |',
    '| 5 | Retention policy and legal retention window per department | Drives the evidence clock; 7–15 days observed on this estate |',
    '| 6 | Named authority for watchlist provisioning, and its update cadence | Correlation is only as current as its watchlist |',
    '| 7 | Operator roster with roles, for the RBAC matrix | Access control |',
    '| 8 | Declared lawful purposes for sensitive queries | Purpose binding is enforced, so the list must exist |',
    '| 9 | AMC status and contact per camera estate | A camera nobody can repair is a permanent gap, and the gap analysis should say so |',
    '| 10 | Escalation path for an alert a department owns | An alert with no owner is an alert nobody actions |',
    '',
    '**D4-06 expands this into a standalone department onboarding questionnaire.** This section is',
    'self-contained and complete as it stands; the questionnaire is the same content as a form a',
    'department fills in.',
    '',
  );

  // ── §9 ────────────────────────────────────────────────────────────────────────────────────────
  w(
    `## 9. ${s(8)}`,
    '',
    'These are accepted limitations carried from the project’s running defect and finding log',
    '(`BL-01`), triaged before submission. They are stated here because a design document that lists',
    'only its strengths tells a reader nothing they can use.',
    '',
    '### Assumptions',
    '',
    '| # | Assumption | If it is wrong |',
    '|---|---|---|',
    '| A1 | Departments will expose a stream endpoint but will not surrender their video | The architecture is unchanged — this is the assumption it is built on |',
    '| A2 | One accelerator-equipped node per district is procurable | The sizing model recomputes for any node count; coverage per district falls |',
    '| A3 | Camera coordinates can be supplied or surveyed | Spatial outputs degrade to a table view; cameras are marked `unassessable`, not guessed |',
    '| A4 | 2 Mbps per camera is representative for the centralised comparison | Vendor-listed, tagged as such in the sizing model; the ratio moves, the conclusion does not |',
    '| A5 | Crop size on live feeds lands in the 3–15 KB band | Measured only on small replay frames. Every storage figure is a band because of it |',
    '| A6 | The measured event rate from the sandbox generalises | Tagged *measured* with its ticket. One quiet-machine re-measurement is the stated caveat |',
    '',
    '### Constraints and accepted limitations',
    '',
    '| # | Constraint | Status |',
    '|---|---|---|',
    `| C1 | **ANPR read accuracy on this estate is ${MEASURED_ANPR.precision}** | Accepted and published. A camera-placement finding, not a model finding (§5) |`,
    '| C2 | **No live government-database connectivity** | By design. Connectors specified, mock provider ships (§4) |',
    '| C3 | **No face recognition; no biometrics processed** | Deliberate (§5) |',
    '| C4 | **Vehicle re-ID ships disabled at 0.761 precision** | Below the 0.900 bar; three independent off-switches ([`docs/limitations.md`](limitations.md)) |',
    '| C5 | **Cross-camera re-ID is unmeasured, and the diagnostic points the wrong way** | No plate anchor exists on this estate to label a cross-camera pair. Stated, not estimated |',
    '| C6 | **21% of tracked passes do not hold a single vehicle** | Measured. Anything treating one track as one vehicle inherits it (§5) |',
    '| C7 | **Uptime is not measured over a meaningful period** | 100.000% over 30 stable minutes is not a production availability claim, and is not presented as one |',
    '| C8 | **API p95 exceeds 200 ms at 500 concurrent** | 110 ms at 200, 252 ms at 500. Reported as a partial meet |',
    '| C9 | **Impossible-transition sweep flagged 2 of 7 assessable transitions** | The tool itself flags that rate as implausibly high for genuine cloning — a sparse-estate artefact, reported rather than presented as 28.6% cloning |',
    '| C10 | **Trusted road coverage is 0.00 km** | The estate’s finding, and the reason the gap analysis exists (§7) |',
    '| C11 | **Analog cameras are reached only through an existing encoder** | We add no hardware. A department with no encoder needs one before integration |',
    '| C12 | **The NL-query LLM is the one optional proprietary dependency** | Behind a four-provider interface including local `ollama` and `none`. Nothing proprietary is load-bearing |',
    '',
    '[`docs/limitations.md`](limitations.md) carries the measured detail behind C4–C6, and D4-08',
    'triages the full `BL-01` log into limitations and a roadmap.',
    '',
    '---',
    '',
    '## How to check this document',
    '',
    'Nothing here asks to be taken on trust.',
    '',
    '```bash',
    'npm run docs:render                              # regenerates this document and its PDF',
    'npm run docs:linkcheck                           # every internal link resolves',
    'npm run deck:build                               # the deck, from the same sizing model',
    'npm run report:gap-analysis                      # the coverage figures in section 7',
    'npm run audit:verify                             # recompute the whole audit chain',
    'npm run export:verify                            # re-hash an evidence bundle independently',
    'npm run test -w @saakshi/api -- hld               # asserts this document against the deck',
    '```',
    '',
    '| Document | What it holds |',
    '|---|---|',
    '| [`docs/claims-provenance.md`](claims-provenance.md) | Every printed figure, its ticket, and the command that reproduces it |',
    '| [`docs/sizing-model.md`](sizing-model.md) | The sizing model and every constant’s provenance tag |',
    '| [`docs/adapter-framework.md`](adapter-framework.md) | §2 in full |',
    '| [`docs/watchlist-integration.md`](watchlist-integration.md) | §4 in full |',
    '| [`docs/alerting.md`](alerting.md) | §6 in full |',
    '| [`docs/anpr-accuracy.md`](anpr-accuracy.md) | The §5 measurement’s sampling method |',
    '| [`docs/trust-score.md`](trust-score.md) | The §7 trust pipeline |',
    '| [`docs/chain-of-custody.md`](chain-of-custody.md) | The audit chain and export manifests |',
    '| [`docs/limitations.md`](limitations.md) | Measured limitations |',
    '| [`docs/deployment.md`](deployment.md) | How it is deployed and run |',
    '',
    '*Generated by `npm run docs:render`. Do not edit `docs/HLD.md` by hand — edit',
    '`packages/api/src/jobs/hld.ts`.*',
    '',
  );

  return `${out.join('\n')}`;
}

/** Write `docs/HLD.md`. Returns the path written. */
export function writeHldMarkdown(root: string = REPO_ROOT): string {
  const target = path.join(root, 'docs', 'HLD.md');
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, hldMarkdown(), 'utf8');
  return target;
}

/** Read `docs/HLD.md` back, for the PDF step. */
export function readHldMarkdown(root: string = REPO_ROOT): string {
  return readFileSync(path.join(root, 'docs', 'HLD.md'), 'utf8');
}
