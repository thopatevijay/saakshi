# Evidence store — path convention, access model, retention, measured storage

> **D2-02.** Vehicle attributes (colour, body type) and the MinIO object store that holds the crops.
> Companion code: `workers/analytics/attributes.py`, `workers/analytics/evidence.py`,
> `packages/api/src/services/evidence.ts`, `packages/api/src/consumers/evidence.ts`,
> `config/evidence-retention.json`.

An alert an officer cannot verify in three seconds is noise. The crop is what makes it verifiable,
and the hash of the crop's bytes is what makes an export defensible in front of a forensic
university a year later. That is the whole reason this store exists.

It is also the line item that decides whether the architecture is affordable. PROJECT.md §9 states
the rule plainly: **store crops only for best shots and watchlist hits.** A crop per sighting is the
design that makes a national-scale estate unaffordable, and the code refuses it structurally rather
than by convention — see [One crop per track session](#one-crop-per-track-session).

---

## 1 · Path convention

```
evidence/<camera_id>/<yyyy-mm-dd>/<sighting_id>-<kind>.jpg
```

| Segment | Value | Why |
|---|---|---|
| `evidence/` | fixed | The retention rules' root prefix. |
| `<camera_id>` | the camera's **external** id (`cam01`) | Not the uuid. The external id is what the upstream catalogue, the stream URLs, every operator and every screenshot already use; a bucket keyed by uuid is one no human can navigate, and the uuid is one join away when it is needed. |
| `<yyyy-mm-dd>` | UTC date of the **sighting** | Never the upload date. A crop that lands at 00:04 for a vehicle seen at 23:58 must retain under the day it was *seen*, or the retention clock is wrong by a day at exactly the moment somebody is asking whether evidence still exists. |
| `<sighting_id>` | `sightings.id` (uuid) | The row and the object name each other. There is no orphan class: the consumer looks the row up *before* it uploads, so a record with no row writes nothing. |
| `<kind>` | `vehicle` \| `plate` | Both are written by **this** consumer (D2-11). One uploader, one bucket, one retention rule, one export walker. |

Example:

```
evidence/cam01/2026-09-05/00323491-77ee-40ee-bcdb-fb84632f76d6-vehicle.jpg
```

`sightings.crop_uri` stores **`s3://<bucket>/<key>`**, never a signed URL. A signed URL is a
credential with an expiry: persisting one would put a value in the database that stops working, and
an export bundle would ship a link that is dead before anyone opens it. URLs are minted on read.

### Which column holds which crop (D2-11)

| kind | column | set by |
|---|---|---|
| `vehicle` | `sightings.crop_uri` | `storeEvidence` — also writes the colour/body attributes |
| `plate` | `plate_reads.crop_uri` | `storePlateCrop` — writes **only** `crop_uri`, never the sighting's attributes, because a plate crop carries no colour read |

D2-01's `LocalCropStore` also writes a local copy of each plate crop under `evidence/plates/` and
puts a `file://` URI in the row. **That is the fallback, not the destination.** The evidence
consumer overwrites it with the `s3://` URI as soon as it drains the record; with no object store
configured the `file://` URI survives, `services/crop-url.ts` refuses to sign it, and the UI renders
"no crop stored" — which is true. Nothing on any path ever signs a URI it cannot serve: a link that
4xxs looks real and is not.

---

## 2 · Access model

**Nothing in the bucket is public. There is no anonymous read and no anonymous listing.**

| Request | Result | Verified |
|---|---|---|
| `GET` a pre-signed URL | `200`, the JPEG | `curl -fsS` → `HTTP 200 2616 bytes image/jpeg` |
| the same URL after its expiry | `403 AccessDenied · Request has expired` | 1-second signature, fetched 2 s later |
| `GET` the object with no signature | `403` | `curl http://localhost:9000/saakshi-evidence/<key>` |
| `GET` the bucket root (listing) | `403 AccessDenied`, no `<Contents>` | `curl http://localhost:9000/saakshi-evidence/` |

Signing is SigV4, implemented in `packages/api/src/services/evidence.ts` over `node:crypto` — no AWS
SDK. Two verbs and a presigner against one endpoint we control did not justify several megabytes of
client, and doing it here is what lets `presignGet` state its expiry in seconds and *prove* expiry
in a test rather than trusting a library default.

### The one sharp edge: `curl -I` on a signed URL returns 403

The HTTP **method is part of the SigV4 canonical request**. A URL presigned for `GET` is a different
request from a `HEAD` of the same URL, and S3 correctly refuses it:

```
$ curl -fsSI "<signed-url>" | head -1
curl: (22) The requested URL returned error: 403
HTTP/1.1 403 Forbidden
```

This is **not** an implementation defect — it reproduces exactly the same way against the aws-cli's
own presigner. Check a signed URL with a GET:

```bash
npm run evidence:sign -- "<key>" 300                       # print a URL
curl -fsS -o /dev/null -w '%{http_code}\n' "<signed-url>"  # 200
```

### Mint a URL

```bash
npm run evidence:sign                    # signs the first object under evidence/, 15-minute life
npm run evidence:sign -- "<key>" 300     # a specific object, 5-minute life
```

---

## 3 · One crop per track session

Best-shot selection lives in `workers/analytics/attributes.py` (`BestShotSelector`) and runs inside
the analytics worker, on the frame it already has in memory. One candidate is held per
`(camera, track_id)` and exactly one crop is emitted when that track session ends.

**The key is the session-qualified `track_id`, never the raw ByteTrack id.** D1-09 measured raw ids
`1` and `2` being reused across sessions 6 and 9 on `cam03` inside a single run; `track_id` is
`session * 100_000 + tracker_id`, so one best shot per `(camera, track_id)` means one best shot per
*vehicle appearance*. Grouping on the raw id would merge two unrelated vehicles into one piece of
evidence.

A candidate is flushed when:

- its track has not been seen for **3,000 ms of PTS** (`TRACK_IDLE_FLUSH_PTS_MS`) — stream time,
  never wall time, because the gateway throttles and a 3 s PTS gap can take 30 s to arrive;
- the scene cuts (the loop point) or the stream reconnects — the tracker starts a new session and
  nothing may straddle it;
- the camera's PTS jumps backwards by more than the idle window — a loop or a replayed GOP;
- the per-camera candidate cap (512) is exceeded — the oldest goes, so the map is bounded;
- the run ends.

### Best-shot score

```
score = det_confidence
      × min(1, box_diagonal / 160 px)          # apparent size, saturating
      × min(1, laplacian_variance / 120)       # focus, saturating
      × (0.45 if the box touches the frame edge else 1)
```

A product, not a weighted sum, so a zero anywhere cannot be averaged away. The edge penalty is there
because a vehicle half out of frame is poor evidence however large and sharp it is.

---

## 4 · Colour palette

Ten names plus `unknown`. HSV histogram over the **interior** of the vehicle box — x 20–80%,
y 20–72% of the box, because the bottom quarter is wheels, shadow and road. The stored crop is
still the full box plus a 6% margin; the inset governs *voting* only.

Two stages:

1. **Achromatic pixels vote as one block** (`S < 55` or `V < 45` in OpenCV's 0–179/0–255 units) and
   the block's name comes from its **median V**. This is the trick that matters: without it, a
   silver car splits its vote three ways across white/silver/grey and is punished with a low
   confidence for being unambiguously silver.
2. **Chromatic pixels vote per hue band.**

| Name | Rule (OpenCV HSV) |
|---|---|
| `black` | achromatic, median V < 60 |
| `grey` | achromatic, median V < 125 |
| `silver` | achromatic, median V < 190 |
| `white` | achromatic, median V ≥ 190 |
| `red` | H < 8 or H ≥ 170 |
| `brown` | 8 ≤ H < 20 **and** V < 150 |
| `yellow` | 20 ≤ H < 35 |
| `green` | 35 ≤ H < 85 |
| `blue` | 85 ≤ H < 135 |
| `other` | 135 ≤ H < 170 (violet/magenta/pink), or 8 ≤ H < 20 with V ≥ 150 (orange) |
| `unknown` | the read was **refused** — see below |

`other` is a real answer. Orange, pink and purple vehicles exist on this estate, and calling one of
them "red" to avoid an awkward bucket would be a worse lie than admitting the bucket.

### Confidence, and the refusal

Every read carries `vehicle_color_confidence` — the winner's share of the counted pixels. The read is
**refused** (`vehicle_color = 'unknown'`, `attributes_low_confidence = true`) when that share is
below **0.35**, or when it fails to beat the runner-up by **0.08**. The runner-up is never quietly
promoted. Refusing is the point: a control room that cannot trust "white" will stop using the colour
filter entirely, and a filter nobody trusts is worse than no filter.

Both thresholds are **PROVISIONAL** — chosen against the recon-still corpus. The measured refusal
rate is reported below rather than the thresholds being moved until the numbers look good.

---

## 5 · Body type

A rename of the detector's class, and nothing more, because that is all the evidence supports.

| detector class | `vehicle_type` |
|---|---|
| `car` | `car` |
| `truck` | `truck` |
| `bus` | `bus` |
| `motorcycle`, `bicycle` | `two_wheeler` |
| `auto_rickshaw` | `auto_rickshaw` — mapping present, **never produced today** |
| `person` | `NULL` |

**No make, no model, no year.** D3-03 owns the harder identity work; a make/model claim from a
75-pixel box on a traffic camera would be a claim nobody measured.

**COCO has no auto-rickshaw class.** D1-09 recorded whichever of `car`/`motorcycle` COCO said and
left the finer call here; inventing the class would be a claim no model made. The mapping exists so
that when a rickshaw-capable detector lands, exactly one table changes. This is asserted in
`test_auto_rickshaw_is_mapped_but_not_invented`.

`person` gets no body type on purpose. A pedestrian near a vehicle of interest is evidence — which is
why D1-09 keeps the class — but writing a body type for one would put pedestrians into vehicle
attribute queries.

---

## 6 · Retention

`config/evidence-retention.json` → an **S3 lifecycle configuration on the bucket**, applied and read
back with:

```bash
npm run evidence:retention           # apply, then print what the STORE reports
npm run evidence:retention -- --check # print only
```

| Rule | Prefix | Days | Why |
|---|---|---|---|
| `evidence-default` | `evidence/` | 15 | PROJECT.md P3: departments retain footage 7 or 15 days. 15 is the longer regime, so our evidence never expires before the source footage it points at. |
| `evidence-watchlist-hits` | `evidence/watchlist/` | 90 | A watchlist hit is what an investigation is built on. D3-04's export bundles hash these bytes; a 15-day clock would break a manifest three weeks after it was signed. |

Per prefix, not one global number, because a single number models an estate that does not exist.
The path convention is what makes a department's own clock expressible as a rule.

A lifecycle rule rather than a delete job, deliberately: Pillar 4 is the retention clock, an officer
has to be able to see *when* evidence expires, and a policy the object store itself reports is a fact
whereas a cron job is a promise. Verified with an independent client:

```
$ aws --endpoint-url http://localhost:9000 s3api get-bucket-lifecycle-configuration \
      --bucket saakshi-evidence
{"Rules": [
  {"Expiration": {"Days": 15}, "ID": "evidence-default",
   "Filter": {"Prefix": "evidence/"}, "Status": "Enabled"},
  {"Expiration": {"Days": 90}, "ID": "evidence-watchlist-hits",
   "Filter": {"Prefix": "evidence/watchlist/"}, "Status": "Enabled"}]}
```

---

## 7 · Measured storage — the sizing input

### How these numbers were produced, and what they are not

**They are not a live-feed measurement.** The sandbox gateway semaphore was held by another ticket
during this wave, so the pixel path was exercised by replaying the **real D0-01 recon stills** —
actual frames captured from the sandbox cameras — panned to produce apparent motion
(`scripts/build-replay-clips.sh`), decoded by the same PyAV pipeline, detected by the same YOLO11n
weights, tracked by the same ByteTrack session tracker. The **pixels are real** and the vehicles in
them are real Gujarat traffic; the **camera motion is synthetic**. Nothing below may be quoted as a
live-feed figure.

Run: 8 cameras (`cam01`–`cam08`), 120.1 s measured window, Apple Silicon MPS, YOLO11n, JPEG quality
82, `2026-09-05`.

| | |
|---|---|
| sightings published | **25,367** |
| best-shot crops stored | **838** |
| **compression** | **1 crop per 30.3 sightings** (33.0 crops per 1,000 sightings) |
| total bytes | 2,440,661 B |
| **mean crop** | **2,912 B** |
| **bytes per 1,000 sightings** | **96,214 B ≈ 94.0 KiB** |
| median crop bbox long edge | 75 px (p90 186 px, max 585 px) |
| objects in bucket after the run | 838 (`aws s3 ls --recursive \| wc -l`) |
| upload failures / unmatched records | 0 / 0 |

### What this does to PROJECT.md §9

§9 budgets **~15 KB per stored crop**, giving 80k × ~40/day × 15 KB ≈ 48 GB/day ≈ **17 TB/year**.

Measured mean is **2.9 KB**, roughly 5× smaller — 80k × 40 × 2.9 KB ≈ **9.3 GB/day ≈ 3.4 TB/year**.

**Do not adopt that figure yet, for a stated reason.** The replay frames are 682×384 to 1536×864
(80% crop windows over the recon stills), so the vehicle boxes are smaller than a 1080p live feed
would produce; median long edge here is 75 px. A live-feed re-measurement on 1920×1080 sources will
land somewhere between the two. The honest statement for D3-08 is: **§9's 15 KB is a conservative
ceiling, and the true figure on this estate is between 3 KB and 15 KB pending a live measurement.**

The number that is **not** provisional is the compression ratio: **~33 crops per 1,000 sightings**,
i.e. best-shot selection removes ~97% of the crops a naive design would store. That ratio is a
property of the tracker and the selector, not of the frame size.

---

## 8 · Measured accuracy — including where it fails

**No accuracy claim here is an accuracy claim about a model.** There is no hand-labelled ground
truth for vehicle colour on this estate. What is measured is the classifier's **refusal rate** — how
often it declines to name a colour — which is an honest proxy for where colour is unavailable, and
which is measurable without labels.

838 best shots, 10.9% refused overall (`vehicle_color = 'unknown'`).

### By scene brightness — the real failure mode

Each replay clip concatenates that camera's four recon stills, so the segment index recovers which
still a sighting came from.

| recon slot | mean scene V | best shots | refused | refusal rate |
|---|---|---|---|---|
| `day` | 134.8 | 359 | 23 | **6.4%** |
| `p62` | 92.2 | 118 | 7 | **5.9%** |
| `p08` | 84.4 | 261 | 56 | **21.5%** |
| `p35` | 73.8 | 100 | 24 | **24.0%** |

The two dimmest slots refuse 3–4× as often as daylight. That is the expected physics — saturation
collapses as light falls, so the chromatic vote disappears and every vehicle reads achromatic — and
it is the number that belongs in the deck rather than the 6.4%. **`p62` is the exception and is
reported as one**: it is dimmer than `p08` on mean luma yet refuses less often, so brightness is a
strong predictor and not the only one. Scene content (how much road versus how much vehicle sits in
the box) plainly matters too, and has not been isolated.

### By class

| class | best shots | refused | refusal rate |
|---|---|---|---|
| `motorcycle` | 98 | 3 | 3.1% |
| `car` | 281 | 24 | 8.5% |
| `bus` | 91 | 8 | 8.8% |
| `truck` | 136 | 16 | 11.8% |
| `person` | 232 | 59 | 25.4% |

**The two-wheeler number is not the good news it looks like.** A motorcycle's box is mostly *rider*,
not vehicle: the classifier reads a uniformly-coloured jacket with high confidence and returns a
colour that describes the person rather than the bike. It is confidently answering a different
question. Treat `two_wheeler` colour as unreliable regardless of its confidence — this is a known
limitation, not a measured strength, and D3-03 is where a body-region mask would fix it.

`person` rows exist because D1-09 keeps pedestrians as sightings; their colour is clothing, which is
why they carry no `vehicle_type`. **No biometrics are processed anywhere in this system, and colour
of clothing is not and must not be used as an identity signal.**

### Colour distribution over the 838 best shots

| colour | count | | colour | count |
|---|---|---|---|---|
| `grey` | 219 | | `white` | 105 |
| `black` | 165 | | `blue` | 47 |
| `silver` | 162 | | `yellow` | 18 |
| `unknown` | 110 | | `red` | 12 |

Mean confidence 0.820 on accepted reads, 0.370 on refused ones — the two populations are well
separated, which is what makes the threshold meaningful rather than arbitrary.

The achromatic skew (546 of 728 accepted reads are white/silver/grey/black) is consistent with the
Indian passenger-vehicle market and with a classifier that treats dark, low-saturation road pixels
inside the box as achromatic. Both effects are present; they have not been separated.

---

## 9 · Wire contract — the `evidence` stream

A **second** Valkey stream, not more fields on `sightings`. `sightings` carries ~1 entry per
detection per inferred frame; `evidence` carries ~1 per track session and each one is a JPEG. One
bounded stream cannot be trimmed correctly for both, and the credentials stay in exactly one place:
the worker holds pixels and no keys, the API holds keys and no pixels.

```
stream key   evidence
entry        XADD evidence MAXLEN ~ 2000 * payload <json>
payload      one EvidenceRecord (packages/shared/src/evidence.ts), camelCase,
             `cameraId` carrying the camera's EXTERNAL id ("cam01")
group        evidence-writer     (created MKSTREAM by packages/api/src/consumers/evidence.ts)
CLI          npm run consume:evidence              (follow)
             npm run consume:evidence -- --drain   (exit when empty)
```

`MAXLEN ~ 2000` against the sightings stream's 200,000: at ~20 KB per entry that is a ~40 MB ceiling
on the broker, and a stopped consumer must not be able to take Valkey down.

The consumer matches a record to its row on `(camera_id, track_id, frame_pts_ms)` — unique *because*
`track_id` is session-qualified. Order of operations is **find the row → upload → update the row**:
looking first means a record whose row has not landed writes nothing at all, so there is never an
orphan object inflating the count.

A `kind: 'plate'` record matches the same tuple but resolves to the `plate_reads` row hanging off
that sighting (D2-11). That is exact rather than approximate: the ANPR engine emits its one voted
read for a track on the frame the vote fires, and `pipeline.py` attaches the read to *that* frame's
sighting payload — so the frame that produced the plate crop is the frame whose sighting owns the
read. `workers/analytics/evidence.py:to_plate_record` builds the record; its vehicle-attribute
fields are `unknown` / `0.0` / low-confidence, because no colour classifier ran on a plate crop, and
the consumer writes none of them anywhere.

**Run `consume:sightings` before `consume:evidence`.** The two streams are independent and a crop
cannot be named until its sighting row exists. The consumer waits and retries (3 × 500 ms) and then
counts the record as `unmatched` rather than redelivering it forever — but starting in the natural
order turns a bounded wait into no wait.

### Schema (migration `0014`)

| column | type | meaning |
|---|---|---|
| `vehicle_color` | text | palette name, or `unknown` when refused |
| `vehicle_color_confidence` | numeric(4,3) | winner's share of the counted pixels, 0–1 |
| `attributes_low_confidence` | boolean | the read was refused |
| `is_best_shot` | boolean not null default false | this row is its track session's stored evidence |
| `crop_uri` | text (0004) | `s3://<bucket>/<key>` |

Plus a partial index `sightings_best_shot_idx (camera_id, ts DESC) WHERE is_best_shot` — best shots
are ~1 in 30 rows and every evidence query filters to them.

---

## 10 · Reproducing all of it

```bash
docker compose up -d --wait db valkey minio          # the bucket is created by minio-init
npm run db:migrate

# 1 · build the replay clips from the recon stills (a TEST RIG, not a live feed)
scripts/build-replay-clips.sh recon-out/frames /tmp/saakshi-replay

# 2 · run the worker with the attribute + evidence stage on
python -m workers.analytics.run --evidence --minutes 2 \
  --source cam01=/tmp/saakshi-replay/cam01.mp4 ... \
  --json /tmp/replay-summary.json

# 3 · drain, in this order
npm run consume:sightings -- --drain
npm run consume:evidence  -- --drain

# 4 · retention, then the checks
npm run evidence:retention
aws --endpoint-url http://localhost:9000 s3 ls s3://saakshi-evidence --recursive | wc -l
psql "$DATABASE_URL" -c "select vehicle_color, count(*) from sightings
                          where vehicle_color is not null group by 1 order by 2 desc;"
curl -s -o /dev/null -w '%{http_code}\n' "http://localhost:9000/saakshi-evidence/"   # 403
```

`mc` is not on this machine; every `mc` command in the ticket's gate was run with its documented
aws-cli equivalent, which the ticket explicitly permits.
