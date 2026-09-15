# SAAKSHI — government-feed demonstration · demo script

**D4-03 · mandatory submission item 4 · evaluation area #1 ("Successful Test Case")**

Generated for the recording. The shot list is `docs/demo-govt-feed-storyboard.md`; this adds the
exact voiceover text and the click path. **Every figure below is quoted from
`docs/claims-provenance.md`** — none is typed from memory.

- **Target:** 2:45–2:55 (AC: 2:00–3:00) · **1080p** · voice **onyx** @ 0.95
- **Recorded against:** `https://saakshi.up.railway.app`, signed in **before** rolling (no credential on screen)
- **Word budget:** ~430 words ≈ 175 s at ~140 wpm

> **The three claims this video must never make** (storyboard, verbatim): no declared-vs-measured FPS
> divergence — no camera carries both values; the cloned-plate pair is **synthetic** and must be named
> as such; nothing may imply VAHAN/SARTHI/eGujCop connectivity or face recognition.


## Cue sheet — measured, not estimated

Real durations from the generated audio. Play `voiceover-full.mp3` on headphones while
recording and change scene at each mark.

| Section | Starts | Runs | Ends |
|---|---|---|---|
| 1 | **0:00.0** | 25.0s | 0:25.0 |
| 2 | **0:25.6** | 23.1s | 0:48.7 |
| 3 | **0:49.3** | 40.5s | 1:29.8 |
| 4 | **1:30.4** | 24.6s | 1:55.0 |
| 5 | **1:55.6** | 38.2s | 2:33.8 |
| 6 | **2:34.4** | 21.1s | 2:55.5 |

**Total 2:55.5** — inside the 2:00–3:00 acceptance criterion.

---

## Section 1 · The registry, and what the catalogue actually publishes (0:00–0:30)

**Voiceover**

> This is SAAKSHI, live on Gujarat Police's own sandbox feeds.
>
> Here is everything the upstream catalogue publishes about a camera: an id, and a name. No codec, no
> frame rate, no resolution, no location.
>
> Every number on this screen — the trust scores, the measured rates, the coordinates — SAAKSHI
> established itself. A registry that lists cameras is a spreadsheet. One that tells you which you
> can *rely on* is infrastructure.

**Screen actions**
1. Start on `/registry` with the GIS map drawn — 85 cameras, 54 on the map, 31 without coordinates.
2. Hold on the **NOT ON THE MAP · 31** panel: it states, in the product, that the upstream catalogue
   publishes only an id and a name and that a coordinate must be added before a route can run.
3. Scroll the trust-score column — 95, 100, 83, 35 — every one of them measured by the prober.
4. **Do not** show or mention a declared-vs-measured FPS delta: no camera in this estate carries both.

> **Changed from the original storyboard shot, and why.** The storyboard called for running
> `npm run sync:catalogue` on camera to evidence "onboarding shown live, not pre-baked". A terminal
> cannot be put in frame without also putting the operator's own machine in frame, so this shot
> evidences the same claim from inside the product instead: the registry's own copy states what the
> catalogue publishes, and every measured column is the result of the sync plus the prober.
>
> **The sync is still run live** — 30 unchanged, 55 correctly marked absent, 2.2 s, recorded in
> `catalogue_sync_runs` with a run id — it is simply not the thing on screen. **AC 1 is therefore
> partially met and is reported as partial**, not claimed."

---

## Section 2 · Unified viewing across departments (0:32–1:02)

**Voiceover**

> Twenty-six departments own these cameras. SAAKSHI asks none to hand over infrastructure; it
> federates what's there into one console.
>
> Watch the badge on each tile. That's the *measured* delivery rate — a fraction of real time,
> because that is what the upstream gateway sends. It's not this console, and the product says so on
> the tile instead of spinning it.

**Screen actions**
1. `/video-wall`, **2×2, already warm** (started warming well before the take).
2. Hover a tile so the per-tile delivery badge is legible.

> **Do not name a delivery-rate range in the narration.** The storyboard quotes D3-07's measured
> 0.12×–0.28×, but the badge shows whatever the gateway is doing *now* — 0.10× and 0.14× at the time
> of recording. A spoken range that the on-screen badge contradicts is a self-inflicted wound in a
> video whose argument is that every number is real.
3. Open one tile full-screen via `/video-wall?camera=<uuid>`.

---

## Section 3 · ANPR output, with the numbers that don't flatter us (1:02–1:46)

**Voiceover**

> ANPR is the one analytic this challenge makes compulsory. Here it is on a government camera, live
> from the database.
>
> The system read "1118R" at nought point six three confidence, on camera five, Visat teen Rasta.
> And this is the image it read.
>
> That's a roadside hoarding. A phone number. Not a vehicle, and not a registration.
>
> Three of the four reads this estate produced are that same hoarding. Across a hundred and twenty
> hand-labelled vehicles, SAAKSHI got zero exact plate reads. Zero.
>
> These are wide-area traffic cameras, built for scene overview, not plate capture. That's a
> camera-placement finding, not a model finding.

**Screen actions**
1. `/trace?plate=1118R` with a stated purpose — one of the four reads the government feed actually
   produced.
2. Scroll to **EVIDENCE · CHRONOLOGICAL** and hold on the crop. It is a hoarding reading
   `75750 83008`; the row beside it reads `05 Visat teen Rasta · read 1118R · Exact plate match · 0.63`,
   with the PTS-derived timestamp and `cam05 · not placed`.
3. Let the image sit. It makes the argument better than the narration does.

> **Changed from the first cut, deliberately.** This shot was `submission/govt-feed-output-report.pdf`
> open at the crops table. It worked, but a third of the video became a static document — and a PDF
> *asserting* that a read is a hoarding is strictly weaker than the product *showing* it. The report
> is still a submission deliverable; it is no longer the demo.

---

## Section 4 · Watchlist correlation, and a product that refuses to overclaim (1:46–2:16)

**Voiceover**

> Every read is correlated as it lands — exact first, then a confusion-weighted fuzzy match tuned
> for how Indian plates actually fail at night.
>
> Two fuzzy hits, five exact. But look at what the alert leads with: before the severity, it tells
> the officer this string isn't a registration.
>
> The alert fires, and the record carries its own provenance — the match type, the distance, the
> entry it hit. It just refuses to call it an identification, because it isn't one.

**Screen actions**
1. `/alerts`. Show the queue: fuzzy and exact visually distinct — different colour, border and word.
   The standing banner naming the mock providers is in frame — let it be read.
2. Open one alert. Hold on the "NOT A REGISTRATION" / "PARTIAL READ" line and the match badges.

> **Corrected after the dry run: do NOT say "the evidence is preserved" here.** Verified in the
> deployed database — **not one of the seven production alerts carries a crop**; every thumbnail
> reads `no crop stored`. The crops shown in section 3 are plate-read crops from the output report,
> which is a different path. Claiming preserved evidence over a row of "no crop stored" thumbnails
> is exactly the kind of small overclaim this video exists to avoid.

---

## Section 5 · Cross-camera trace and route reconstruction (2:16–2:48)

**Voiceover**

> A trace needs a stated purpose — required, and written into a tamper-evident audit chain against
> my badge.
>
> The reconstructed route: solid where a camera observed the vehicle, dashed where it's inferred.
> SAAKSHI never draws an inference as though it were an observation.
>
> And here's an impossible transition — two reads nine point two four kilometres and thirty seconds
> apart. That demands eleven hundred and nine kilometres an hour. One plate, two vehicles.
>
> This pair is synthetic — we seeded it, because a real cloned plate isn't something you can wait
> for on a three-day build. The tool says so itself, and so do I.

**Screen actions**
1. `/trace`, enter purpose, trace `GJ01AB1234`.
2. Show route with OBSERVED solid / INFERRED dashed, and the legend.
3. Hold on the impossible-transition flag and the tool's own "SYNTHETIC" warning.

---

## Section 6 · Close (2:48–2:58)

**Voiceover**

> Every trace exports as CSV or PDF, generated from the live database — each row traceable to a
> plate-read id, each timestamp derived from presentation timestamps, not arrival time.
>
> And it ends on this: fuzzy links are ranked possibilities, not identifications.
>
> Every number in this video came from the system you just watched. And where it fails, we say so.

**Screen actions**
1. The foot of the trace: the evidence table with `CONF` and `LINK` columns, the **Export CSV** and
   **Export PDF** buttons, and the closing disclaimer.
2. End held on the disclaimer — *"Fuzzy links are ranked possibilities, not identifications."*
