# Government-feed demonstration — storyboard

**D4-03 · mandatory submission item 4 · evaluation area #1 ("Successful Test Case")**

A 2:00–3:00 screen recording of the **live system** on the **government sandbox feeds**. Same
discipline as `docs/demo-own-feed-storyboard.md`: nothing pre-baked, nothing staged, and every number
on screen produced by the thing being shown.

The companion artefact — `submission/govt-feed-output-report.{csv,pdf}` — is already generated and
does not depend on this recording. This document is the shot list for the video half.

---

## Before you roll — three things that will ruin a take

**1 · Leave the gateway alone for 15–20 minutes first.** D1-03 and D1-05 measured the sandbox
throttling roughly tenfold under sustained use: a 1.3 KB `cameras.json` went `4.2 s · 15 s · 17 s ·
28 s · 36 s · 41 s · 63 s` across one session, and a `cam01` probe that normally takes 84 s did not
finish in 20 minutes. `npm run test` is now ~5 minutes and includes 350 s of live sandbox traffic
(D4-11), and a full prober sweep is 23.6 minutes. **Either will make a live demonstration look
broken on camera.**

Check before rolling — under ~5 s is healthy:

```bash
set -a; . ./.env; set +a
curl -s -o /dev/null -w "%{time_total}s\n" -H "Cookie: $SENTINEL_PORTAL_COOKIE" \
  -H "User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/128" \
  "https://${SENTINEL_HOST}/cameras.json"
```

**2 · The wall fills slowly, and that is the estate.** D3-07 measured the gateway delivering a 6 s
segment in 22–49 s — 0.12×–0.28× real time. On a cold 3×3, four to six of nine tiles had a picture
after ~5 minutes. **Do not plan a shot that assumes nine live tiles in ten seconds.** Every tile
shows its own measured delivery rate and says whose problem it is, so this is shootable — but shoot
it as a 2×2 that is already warm, and let the badge do the explaining.

**3 · Seed the cloned-plate fixture, or shot 5 has nothing to show.** It is opt-in by design:

```bash
npm run demo:trace -w @saakshi/api -- --seed --clone
```

Then clear the route cache and re-run one trace with `?reconstruct=true`, or the sweep reads stale
segments and reports that nothing was testable (D4-10).

**Nothing on screen may show a credential.** Sign in before recording starts, or cut the login. The
badge number is fine; the password field is not, and neither is `.env` in a terminal.

---

## Shot 1 · Onboarding a government feed — live, not pre-baked  (0:00–0:30)

**AC 1.** Start on `/registry` with the estate already synced, then run the sync **on camera** so the
onboarding is visibly live:

```bash
npm run sync:catalogue -w @saakshi/api
```

Say, over it: the upstream catalogue publishes `{"id": "cam01", "name": "01 Chiman bhai Bridge"}` and
**nothing else** — no codec, no fps, no resolution, no coordinates. Everything else in the registry
was *measured by us*, and that is the whole argument of Pillar 1.

Cut to a camera drawer and show **declared vs measured** side by side.

> **Do not claim a declared-vs-measured FPS divergence.** BL-01 finding 22: the 30 measured cameras
> declare nothing and the 50 that declare have no reachable endpoint, so **no camera carries both
> values**. Show the measured column and say the catalogue declared none.

## Shot 2 · Unified viewing across departments  (0:30–1:00)

**AC 2.** `/video-wall`, 2×2, already warm. Point at the per-tile delivery badge and read it out:
`0.12×–0.28× real time` is the gateway, not the console, and the product says so rather than
spinning.

Then open one tile full-screen via `/video-wall?camera=<uuid>` to show the same stream unified from a
single console regardless of which department owns the camera.

## Shot 3 · ANPR output with confidences  (1:00–1:40)

**AC 3.** Show the analytics output on `cam04` / `cam05` — the two cameras that actually produced
reads — with the confidence visible on each.

**Then be honest on camera, because the crops make it undeniable.** Open
`submission/govt-feed-output-report.pdf` at the crops table: three of the four reads are the **same
roadside hoarding** reading `75750 83008`, returned by the OCR as `757508300` (0.888 — the
highest-confidence read of the run), `1118R` and `755508000`. The fourth, `P41`, is a blue sign on
`cam04`. **Not one is a vehicle registration**, and the crop beside each row shows it.

Say it plainly: this estate is wide-area CSITMS traffic-overview cameras built for traffic
monitoring, not plate capture, and roughly nine of its twelve recorded hours are dark. D2-01 measured
**0 exact plate reads across 120 hand-labelled instances**. That is the measurement, it is in
`docs/anpr-accuracy.md` with its method, and the report quotes it rather than inventing a kinder one.

## Shot 4 · Watchlist correlation firing  (1:40–2:10)

**AC 4.** `/alerts`. Show an alert and open it: the row leads with **"Not a registration"** before the
severity, because five of the seven alerts on this estate are string collisions on an OCR fragment.
Show the fuzzy-vs-exact distinction — different colour, different border, different **word**.

This is the shot that proves the product refuses to overclaim: the alert exists, and the product
itself tells the officer it is not an identification.

## Shot 5 · Cross-camera trace with route reconstruction  (2:10–2:45)

**AC 5.** `/trace`, state a purpose (it is required, and it is written into the audit chain against
your badge), and trace `GJ01AB1234`.

Show the reconstructed route with **OBSERVED solid and INFERRED dashed**, and the impossible
transition: two reads 9.24 km apart with 30 seconds between them, demanding 1,109 km/h.

> **Say that the cloned-plate pair is synthetic.** The tool prints it and so should you: *"a SECOND,
> SYNTHETIC vehicle wearing GJ01AB1234 — never quote it as an observation."* And quote the sweep's
> own caution: 28.6% is implausibly high for genuine cloning, and should be read as an OCR-or-clock
> finding first.

## Shot 6 · The output report  (2:45–3:00)

Close on `submission/govt-feed-output-report.pdf`: the summary counts, the accuracy section that
reports a **MISS** against the challenge's >90% target, and the limitations page naming every camera
that saw vehicles and read no plate.

Last line: *every number in this video came from the system you just watched, and where it fails we
say so.*

---

## What this video must never do

- **Claim a plate read is a vehicle identification.** It is a string, and on this estate usually not
  even that.
- **Show a declared-vs-measured FPS divergence.** No camera in the estate carries both values.
- **Present the cloned-plate pair as observed.** It is synthetic by construction.
- **Imply VAHAN / SARTHI / eGujCop / AFIS / NAFIS connectivity.** There is none. Connectors are
  specified with a mock provider.
- **Imply face recognition.** Deliberately out of scope; no biometrics are processed.
- **Show a credential**, a `.env`, or a signed URL in a terminal or address bar.

## After the recording

1. Review end to end **on a second device** — text legible after compression at 1080p.
2. Upload **unlisted**.
3. Record the URL in `.dev-refs.md` (gitignored) and as a comment on #38.
4. Reconcile the accuracy figure against D4-04's deck before submitting — D4-03's handoff requires
   them to be the same number.
