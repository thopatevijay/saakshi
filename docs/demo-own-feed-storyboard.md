# Own-feed demonstration — storyboard

**Ticket** D3-11 · **Mandatory submission item 3** · **Target** 2:00–3:00, recorded at 1920×1080.

The challenge rules are explicit: *"Mock-ups, animations, simulated interfaces, or concept videos
without an operational backend will not be considered."* Everything in this storyboard is a route of
the running system, driven by a script anyone can re-run. Nothing is composited, nothing is drawn,
and no caption may claim anything the frame does not already show.

This is the **own-feed** video. The government-feed video is D4-03 and reuses this structure.

---

## 1 · How the master is recorded

```bash
node packages/web/scripts/record-demo.mjs <token-file> [out] [base-url]
```

**CDP screencast, not a desktop screen recorder.** Three reasons, all of which matter to a
submission:

- it is **reproducible** — anyone can re-run it and get the same take;
- it captures the page and nothing else — no menu bar, no cursor, no notification sliding in over
  the evidence, and **no terminal with a `.env` in it** behind the browser;
- it runs headless, so the recording does not depend on whose laptop is in front of the camera.

There is also a hard constraint on this machine: without Screen Recording granted to the terminal,
`screencapture` answers `could not create image from display` and ffmpeg's avfoundation lists no
screen device at all. CDP has no such dependency.

**Frame timings are real.** Frames are written with their own timestamps and ffmpeg is handed a
concat list with real per-frame durations, so the master plays at the speed the system actually ran
at. Encoding at a nominal fps would speed the recording up or slow it down by however much the
machine was misbehaving, and the demonstration would be a lie about the product's responsiveness.

**The master carries no burnt-in captions.** It is raw material for a re-cut (D4-03 reuses it), and
every caption below is a claim that has to be checked against the frame at that timestamp. Baking
them in would put them beyond review.

### The token

`<token-file>` must hold a token for a role with `video:view`, `trace:run`, `alerts:acknowledge`
**and** `audit:read` — that is `admin` or `supervisor` only. An `operator` gets a 403 on `/audit`
and the last beat films an error page. See `docs/rbac.md`.

```bash
curl -s -X POST http://localhost:4100/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"badgeNo":"GP-ADM-0001","password":"saakshi-dev"}' | jq -r .token > /tmp/admin.token
```

---

## 2 · Preparing the estate — order is load-bearing

```bash
export DATABASE_URL=postgres://saakshi:saakshi@localhost:5432/saakshi_d3_11

npm run demo:trace  -w packages/api -- --remove   # if it is already seeded
npm run demo:alerts -w packages/api -- --seed     # MUST run with TRACEFIX cameras absent
npm run demo:trace  -w packages/api -- --seed
```

**`demo:alerts` must be seeded while the trace fixture is absent.** It round-robins its measured
reads over "the cameras that have sightings", and once `demo:trace --seed` has run, the five
`TRACEFIX-*` cameras qualify on 1–3 sightings each — so `--seed` throws
`camera TRACEFIX-CAM-C has no sighting at offset 2`. This is not documented anywhere upstream and
cost this ticket three failed attempts.

**`demo:alerts --remove` is currently broken** and cannot be used to reset between takes — it fails
with `cannot cast type record to uuid[]`, because the sighting-id array is interpolated as a record
rather than a `uuid[]`. D2-07's handoff describes it as "exact and idempotent"; it is not, on this
drizzle version. Logged to BL-01. To reset the queue to the documented seven between takes:

```sql
delete from alerts a using (
  select id from alerts order by created_at desc limit (select count(*) - 7 from alerts)
) d where a.id = d.id;
```

### The database needs a sightings corpus, and a fresh one does not have it

`demo:alerts --seed` fails with `no camera in this database has any sighting` on an estate that has
only been migrated and seeded with cameras. The corpus is regenerated from the D0-01 recon stills —
no gateway traffic, ~23 min:

```bash
scripts/build-replay-clips.sh recon-out/frames /tmp/saakshi-replay \
  cam01 cam02 cam03 cam04 cam05 cam06 cam07 cam08
npm run consume:sightings &            # writes the bus into Postgres
python -m workers.analytics.run --evidence --minutes 3 \
  --source cam01=/tmp/saakshi-replay/cam01.mp4 … --source cam08=/tmp/saakshi-replay/cam08.mp4
```

Measured on this run: **38,194 sightings published across 7 cameras** (cam03 yielded 0), 16,415
frames, 1,261 best-shot crops at a mean 2,931 B — **1 crop per 30.3 sightings**, which reproduces
D2-02's compression ratio exactly. **Kill the consumer before running the test suites**: a live
`consume:sightings` drains the shared Valkey stream and fails other workers' consumer tests.

### Services

| what | where | note |
|---|---|---|
| API | `:4100` | `next start` and the verify scripts assume 4100, not the dev default 4000 |
| Web | `:3100` | **`next start` serves the BUILT output — rebuild after any source change** |
| OSRM | `:5050` | macOS AirPlay owns `:5000`; `OSRM_HOST_PORT=5050 OSRM_URL=http://localhost:5050` |
| Postgres | `saakshi_d3_11` | never the default `saakshi` |

**Do not record straight after a test run.** `npm run test` wipes the `GJ-*` estate
(`routes/cameras.test.ts` deletes `external_id like 'GJ-%'`), and D1-03/D1-05 measured the sandbox
gateway throttling roughly tenfold under sustained use. Run the suites first, let the machine
settle, then record.

---

## 3 · The storyboard

Timings below are from the recorded master (`d3-11-own-feed-master.mp4`, **2:26.8**, 1920×1080,
1,564 screencast frames over 146.6 s). The recorder writes the same marks to
`<out>.marks.json` on every run.

### Beat 1 — the problem, over the GIS registry · 0:00–0:13

**On screen** `/registry`. The estate summary reads **35 cameras · 4 on the map · 31 without
coordinates**. The coverage overlay is toggled on and its legend reports **Covered (trusted) 0**,
**Covered (untrusted or never probed) 0**, and the trust band panel reads **Never probed 35**.

**Caption** *"Twenty-six departments, ~80,000 cameras, no single registry. Of the cameras we can
see, none has ever been probed and almost none has coordinates."*

**Why this opens the video.** The coverage legend's own words are the pitch: *"A conventional
coverage map draws this the same colour as trusted coverage. That is the false assurance this
overlay exists to break."* Do not caption a coverage percentage — `0.00 km` of trusted coverage is
the honest figure and it is on screen.

### Beat 2 — the estate, and what is actually known about it · 0:13–0:24

**On screen** `/video-wall`, 3×3. Every tile reports **"No stream URL resolves for this camera.
`GET /api/ingest` is the contract and the registry row carries no endpoint — this is configuration,
not a fault."** Tiles carry real sighting counts: **1,327**, **7,315**, **5,428**.

**Caption** *"Nine tiles, and the wall says plainly which of them it cannot reach and why."*

> **Do NOT caption this as nine live feeds.** It is not, and D3-07 recorded AC 1 as
> measured-and-attributed for exactly that reason. The sighting counts are real YOLO11 detections;
> the tiles are empty because `SENTINEL_HOST` is unset in this environment.

### Beat 3 — our own feed, two transports, one clock · 0:24–0:49

**On screen** the single-camera view, then **"Compare HLS vs WHEP on the edge gateway"**. Both panes
play `saakshi-test` from **our own MediaMTX relay** — HLS on :8888, WHEP on :8889. The source
carries a **burnt-in timer**, so the gap between the two clocks *is* the latency difference. At
0:42 the WHEP pane is running (**first frame 220 ms**) while the HLS pane still reads
**"measuring · 0 frags"**.

**Caption** *"The same source through both transports. WebRTC has a first frame in 220 ms; the
segment-based path is still buffering. This is our own gateway."*

**The honesty that must survive the edit**, and it is already on screen in the product's own words:
*"The government sandbox serves HLS over HTTPS only — it exposes neither RTSP nor WHEP (verified in
D1-03) — so low-latency WebRTC is demonstrated against our own MediaMTX relay, not claimed against
the sandbox."*

### Beat 4 — watchlist correlation, and an alert that arrives on camera · 0:49–1:51

This is the beat D2-07's handoff scripted, and its order is followed exactly.

**0:49 — the claims banner first.** `/alerts?sort=severity`. In the product's own words:

> **MOCK PROVIDERS** — SAAKSHI has no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity.
> This match is against the representative watchlist database this project ships. No biometric data
> is processed and no face recognition is performed anywhere in SAAKSHI.
>
> This queue holds **7 alerts — 5 exact and 2 fuzzy (2 medium, 5 low)**. An **exact** match means
> the read string equals a watchlist string — on this estate those strings are usually OCR
> fragments, not registrations, and the record's own provenance note says so. A **fuzzy** match is
> a ranked possibility, never an identification.

**Leading with this is what makes everything after it credible.** Every row leads with a *word*, not
a number: `NOT A REGISTRATION`, `PARTIAL READ — 2 CHARACTERS SHORT`, and strengths read
`Weak identification` / `Possible identification`. Every row shows `trust never probed`, `no
location on file`, `no crop stored` — explained nulls, never a zero.

**Caption** *"Seven alerts. Five are exact string matches on OCR fragments — not identifications,
and the queue says so before anyone asks."*

**0:58 — `j` then `a`, keyboard only, no mouse.** The cursor moves to the first row and
acknowledges it. D2-07 measured this verdict round trip at **132 ms**.

**1:02 — `↵` expands a fuzzy row.** The evidence panel shows the caveats, the severity basis, and
the watchlist record's own provenance note — several seed rows literally read **"SELECTED FROM
MEASURED ANPR OUTPUT, NOT FROM A VEHICLE REGISTRY"** — plus `live: false`. This is the shot that
answers *"how do you know?"*.

**Caption** *"Expand any row and the reasoning is already written for an officer: what matched, how
far apart, and where the watchlist record came from."*

**1:15 — an alert arrives, on camera, with no refresh.** `npm run demo:alerts -- --live cam02` is
spawned **from a separate process** while the queue is open. The queue grows from 7 to 8 with no
navigation. Because the raising process is not the API, this is also a real test of the `NOTIFY`
fan-out — if it were broken, the queue would simply never grow.

**Caption** *"A new alert, raised by a different process, arriving over the stream. No refresh."*

> **Editing note.** `npx tsx` cold-starts in ~20 s, so the master has roughly 25 s of a static queue
> before the row lands. The recorder starts the raiser *before* the dwell so the arrival falls
> inside it; **trim the remaining dead air in the cut**. That pause is Node starting, not the
> product being slow, and leaving it in would misrepresent the product in the opposite direction.

### Beat 5 — trace: a purpose first, then observed vs inferred · 1:51–2:16

**1:51 — the empty state is a feature, and it is filmed as one.** `/trace?plate=GJ01AB1234` lands
with the registration filled and the search **not run**:

> **State a purpose before searching GJ01AB1234.** Every trace is written into the tamper-evident
> audit chain against your badge, with the reason you give here and the case reference if you
> supply one. **Nothing has been searched yet.**

`traceHref()` deliberately carries no purpose: a link can name a vehicle, only a person can state a
reason. **This is intentional, not a regression** (D3-04).

**1:57 — the officer types `FIR 123/2026 vehicle movement`, and only then does it search.**

**Caption** *"A trace cannot run without a stated reason. The reason is bound to the search, not to
a checkbox."*

**On screen after the search** — every figure here is measured on this run, not quoted from a doc:

| | |
|---|---|
| sightings | **7 sightings · 4 exact / 3 fuzzy · 6 of 7 mappable (4 of 5 cameras placed) · 7 with a crop** |
| route | **0.0 km observed · 18.4 km inferred** |
| segments | **6 segments (1 observed, 5 inferred) · 5 cameras (4 placed) · 41 min elapsed** |
| build | **25 ms · road graph live · model d3-01.1** · mean inferred confidence **0.49** |

The legend states the distinction in plain language: **Observed** solid — *"the movement itself was
on video"*; **Inferred** dashed — *"no camera watched the vehicle here"*. The summary adds
*"18.4 km is a lower bound"*. The impossible-transitions panel is worded **"not shown to be
impossible"**, never an accusation, and says in the same breath: *"This system has no link to VAHAN
or SARTHI, so it cannot confirm that a registration exists, that it was validly issued, or who
holds it."*

**Caption** *"Solid is observed — a camera watched it. Dashed is inferred — the road graph's most
plausible path, with the confidence beside it. The product never asserts the route as fact."*

> **⚠ Frame-by-frame check required here — see §5.** The evidence strip at the bottom of this beat
> shows real crops from the recon corpus.

### Beat 6 — the chain of custody · 2:16–2:27

**On screen** `/audit`. The banner reads **Chain verifies · 13 entries · 13 verified · 0
pre-canonical · 0 forks**, with the chain tip hash, and states the limit of the claim in the same
breath as the verdict:

> A passing verification proves tamper **EVIDENCE**, not tamper prevention: any alteration to a
> single entry is detectable, as is any removal or reordering. It does not prevent an actor with
> database write access from rewriting the chain from a chosen point onward — which is why
> append-only is enforced by the database and not only by this application.

**The loop closes on camera.** The entries below are the video's *own* actions, in order: the
`trace.run` on `GJ01AB1234` carrying the stated purpose **"FIR 123/2026 vehicle movement"**, the
`alert.ack` by `GP-ADM-0001`, and the `alert.raise` from beat 4. A **STATED PURPOSE** column is on
screen for every row.

**Caption** *"Everything just done in this video is already in the chain — who did it, to what, and
the reason they gave. A pass proves tamper evidence, not tamper prevention, and the page says so."*

---

## 4 · What this video deliberately does not claim

Every one of these is already published in the repo's own docs, so contradicting it on camera would
be worse than silence.

- **No live VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity.** Connectors are *specified*, with
  a mock provider. The claims banner says so in frame, at 0:49.
- **No face recognition, no biometric processing** — deliberately, and for legal reasons. Also in
  the banner.
- **Five of the seven alerts are string collisions on OCR fragments**, not identifications.
- **ANPR is the only mandatory analytic.** Everything else in this video is bonus and must not be
  presented as a requirement met.
- **Vehicle re-ID is not shown.** It ships **disabled by default at 0.761 held-out precision**,
  below D3-03's own 0.9 bar. If a future cut shows it, it must show that it is off and say the
  number.
- **No accuracy claim is made from this video.** D2-01 measured **0 exact plate reads over 120
  hand-labelled instances**, because only 3 of those instances carried a human-legible plate at all.
  The alert queue is honest about this; the captions must not undo it.
- **The 3×3 wall is not nine live feeds.** See beat 2.

---

## 5 · Frame-by-frame review before upload — MANDATORY

AC 7 is *"no credentials, tokens, personal data, or real third-party plates visible in any frame"*.
Three of these are satisfied by construction; **the fourth is an open decision.**

| risk | status |
|---|---|
| credentials / tokens | **Safe by construction.** The session token is injected as a cookie over CDP and is never rendered. No terminal is ever on screen — the recorder captures the page only. |
| personal data | **Safe.** The only person shown is the seed user `A. Desai · GP-ADM-0001`, a fixture. |
| plate strings in the queue | **Safe.** They are OCR fragments — `44671`, `1118R`, `AAM412`, `GJ3266416`, `GJ35U07`, `GJ32DD10` — and the queue labels them `NOT A REGISTRATION`. The traced vehicle is the fixture registration `GJ01AB1234`. |
| **crops in the beat-5 evidence strip** | **⚠ OPEN — decide before upload.** |

**The open item, stated plainly.** The evidence strip in beat 5 renders seven real best-shot crops
drawn from the D0-01 recon corpus — real frames of real Gujarat traffic. D2-08's own review of these
crops recorded: *"I could not confirm a single one of the six sightings as that vehicle from its
crop. Five are illegible plate regions; one is a shop sign the detector took for a plate."* At
1920×1080 they are small and, on review, none resolves to a readable third-party registration — but
they are photographs of real vehicles on a public road, and **that is a judgement call a human
should make, not a script.**

Three options, in order of preference:

1. **Blur the strip** for the upload — `boxblur` over the evidence row for beat 5 only. Costs
   nothing and removes the question.
2. **Crop the frame** to exclude the strip during that beat, keeping the map and the route summary.
3. **Accept it** on the recorded finding that no crop is legible — only after a human has looked at
   all seven at full resolution.

Whichever is chosen, **say which in the PR**, because "we reviewed the frames" is exactly the kind
of claim this project does not make without evidence.

### The rest of the gate

- [ ] Watch the upload end to end at 1080p **on a different device**
- [ ] Confirm every caption is something visible in the frame at that timestamp
- [ ] Confirm no secrets / PII in any frame (the table above)
- [ ] Confirm the URL loads **in a logged-out browser**
- [ ] Upload **unlisted**; record the URL in `.dev-refs.md` and as a comment on issue #34

---

## 6 · What could not be filmed in this environment, and why

Stated here rather than quietly dropped, because the ticket's storyboard asked for it.

**"Live detection + ANPR on the video wall with the overlay on"** is not filmable as written on this
machine. With `SENTINEL_HOST` unset — the environment this ticket was given — no sandbox stream
resolves, so every wall tile correctly reports that it has no endpoint, and the detection overlay
has no video to draw over. The only live video we own is the MediaMTX self-test pattern, which
contains no vehicles.

The AI-detection evidence in this cut is therefore **real but static**: the per-tile sighting counts
(1,327 / 7,315 / 5,428 real YOLO11 detections), the ANPR reads driving the alert queue, and the
best-shot crops in the evidence strip.

**To film a live overlay over moving traffic**, one of these is needed:

1. the sandbox feed, held and live — which is **D4-03's** job, not this one; or
2. a local vehicle feed published to MediaMTX and onboarded through the `file` or `rtsp` adapter,
   with the analytics worker running against it and `--anpr` on.

Option 2 is the honest way to make *this* video show a live overlay on our own footage, and it is
the one improvement worth making before submission. It needs road footage we own and are willing to
publish — which is a sourcing decision, not an engineering one.

---

## 7 · Reuse for D4-03

The recorder takes the base URL as an argument and the beats are independent, so the government-feed
cut is the same script against an estate with `SENTINEL_HOST` set. Keep this master for re-cuts.

Everything in §4 applies unchanged to D4-03 — and with a live government feed on screen, §5's
frame-by-frame review becomes **harder**, not easier: real traffic, real plates, filmed live.
