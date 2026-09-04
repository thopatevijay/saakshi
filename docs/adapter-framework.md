# Adapter framework

**Onboarding a new department's VMS means writing one file and adding one line.** Nothing outside
`packages/api/src/adapters/` knows which transport a camera speaks — and that is the claim Model 4's
"System Architecture & Integration Depth" scores, so it is enforced by a test rather than asserted
in prose.

---

## 1 · The honesty table

**This table is the point of this document. It goes into the HLD verbatim.**

| Transport | Status | What it does |
|---|---|---|
| `hls` | **operational** | HLS over HTTPS — VOD or live, AES-128 aware, cookie and browser-UA injection |
| `rtsp` | **demonstrated** | RTSP over TCP — the transport most IP camera estates actually speak |
| `onvif` | **demonstrated** | ONVIF discovery — GetProfiles then GetStreamUri, media delegated to RTSP |
| `whep` | **demonstrated** | WHEP signalling — sub-second WebRTC preview, media peer-to-peer to the browser |
| `file` | **operational** | Recorded clip on disk — reproducible benchmarks and the own-feed demonstration |
| `nvr` | **stub** | Vendor NVR recorded-footage retrieval — STUB, interface only, nothing claimed |

The three words mean exactly this, and nothing looser:

- **operational** — verified against the **real Sentinel sandbox** (`cctv.corp8.cloud`), or against
  real local files. Evidence: `packages/api/src/adapters/adapters.test.ts`.
- **demonstrated** — verified against **local MediaMTX**, and **not** against the government feed,
  because the sandbox serves no such transport. Evidence:
  `packages/api/src/adapters/adapters-mediamtx.test.ts`.
- **stub** — the interface is implemented; every method throws `NotImplementedError` with a message
  saying why. Nothing is claimed to work.

The table is **generated from `adapter.status` in the code**, and a test asserts every value
(`'derives the transport table from the code, so docs cannot drift from reality'`). Documentation
claiming a transport works against the government feed when it does not would be the single most
damaging thing in this submission, so it is not possible to write it by accident.

### Why RTSP, ONVIF and WHEP exist at all if the sandbox has none of them

Because the sandbox is not the estate. Gujarat's real deployment is ~80,000 cameras across many
departments, and that population is overwhelmingly RTSP and ONVIF — the HLS-only VOD gateway is an
artefact of how the *challenge* exposes its sample data, not of how CCTV works.

The published Integrator's Guide describes RTSP on `:8554` and WHEP on `:8889`. Recon (D0-01) found
**neither exists**. So if a live RTSP environment opens for evaluation, the RTSP adapter becomes the
operational path **with no change to any other file** — which is precisely the property being
claimed. That is worth saying out loud in the deck.

---

## 2 · The interface

```ts
interface CameraAdapter {
  readonly kind: 'hls' | 'rtsp' | 'onvif' | 'whep' | 'nvr' | 'file';
  readonly description: string;
  readonly status: 'operational' | 'demonstrated' | 'stub';

  probe(cfg: AdapterCameraConfig): Promise<CameraCapabilities>;
  open(cfg: AdapterCameraConfig, options?: OpenOptions): Promise<StreamHandle>;
  close(handle: StreamHandle): Promise<void>;
  health(cfg: AdapterCameraConfig): Promise<HealthSample>;
}
```

Five methods, no optional extras. An adapter that needs a sixth is a sign the abstraction is wrong,
not that the interface should widen. Where a transport genuinely has a unique step — ONVIF's
`getProfiles()`, WHEP's `negotiate()`, HLS's `extractFrame()` — it lives on that adapter's own
exported type, and only callers that specifically want it reach for it.

`kind` is keyed to the `adapter_kind` enum in `db/migrations/0002_enums.up.sql`. D1-03's original
sketch wrote `'nvr-file'`; the shipped enum has `nvr` and `file` as separate values, and the registry
follows the database because the database is what stores the camera.

### `CameraCapabilities` — what D1-05 and D1-09 consume

```ts
interface CameraCapabilities {
  transport: AdapterKind;      // which transport actually served it
  reachable: boolean;
  decodable: boolean;

  codec: string | null;
  width: number | null;
  height: number | null;

  measuredFps: number | null;  // counted from decoded frames — authoritative
  declaredFps: number | null;  // what the header claims — never used for timing
  durationS: number | null;    // null for a live stream with no ENDLIST

  seekable: boolean;           // VOD with ENDLIST: faster-than-real-time is available
  encrypted: boolean;          // AES-128 segments, or DTLS-SRTP for WHEP

  probeMs: number;
  probedAt: string;
}
```

**Everything here is measured.** The catalogue declares `{id, name}` and nothing else — no codec, no
fps, no resolution, no location — so this is the strongest possible form of Pillar 1's "measure,
don't trust declared metadata": there is no declared metadata to trust.

`measuredFps` and `declaredFps` are separate fields on purpose. See §5.

---

## 3 · Write your own adapter in 20 lines

```ts
// packages/api/src/adapters/my-vendor.ts
import type { CameraAdapter } from './types.js';

export function createMyVendorAdapter(): CameraAdapter {
  return {
    kind: 'rtsp',                     // or a new adapter_kind enum value
    description: 'MyVendor proprietary VMS via its HTTP snapshot API',
    status: 'demonstrated',           // be honest — a test asserts this
    probe: async (cfg) => ({ /* … measure and return CameraCapabilities */ }),
    open: async (cfg, opts) => ({ /* … return a StreamHandle */ }),
    close: async (handle) => handle.close(),
    health: async (cfg) => ({ /* … never throw; report */ }),
  };
}
```

Then **one line** in `packages/api/src/adapters/index.ts`:

```ts
  .register(createMyVendorAdapter())
```

That is the whole integration surface. Four rules, each learned from something that went wrong:

1. **`health()` reports, never throws.** The prober sweeps thousands of cameras in one pass; an
   exception aborts the sweep and the estate loses a whole cycle of health data.
2. **Classify your errors** (§4). Returning a generic failure is how an expired credential gets
   recorded as a broken camera.
3. **Measure, don't read headers** (§5).
4. **Say `null` when you do not know.** WHEP reports `width: null` because an SDP answer genuinely
   does not contain a resolution. Inventing a plausible number is worse than useless — it looks
   like data.

---

## 4 · The error taxonomy

```
AdapterError
├── AuthError            credentials rejected — fix the token, the camera may be fine
├── UnreachableError     network-level: DNS, refused, timeout at connect
├── DecodeError          reached and authorised, but the bytes are not video
├── TimeoutError         the operation exceeded its deadline — not a verdict on the stream
└── NotImplementedError  this transport is a stub
```

**This is a product requirement, not tidiness.** An expired session cookie reported as "camera
unreachable" sends a technician to a working camera and hides the real fault. At 80,000 cameras that
is a maintenance budget spent on nothing.

The sandbox makes it easy to get wrong: an unauthenticated request is answered with a **302 to a
login page**, not a 401. ffmpeg follows the redirect and then fails to parse HTML as a playlist, so
the naive reading is "corrupt stream". `classifyFfmpegError` handles that case explicitly, and
`adapters-auth.test.ts` asserts it against the real gateway with a deliberately bad cookie.

`health()` on an auth failure reports **`connectable: true`, `decodable: false`** with an
`AuthError` message — because the network did reach the camera. A prober that wrote
`connectable: false` there would be recording something untrue.

### Retry policy

`withBackoff` doubles from 2 s to a 30 s cap: **2s, 4s, 8s, 16s, 30s, 30s, …**

The cap matters more than the curve. A tight reconnect loop against a government gateway is
indistinguishable from a denial-of-service attempt, and getting an integrator's IP blocked would end
the project rather than the stream. Feeds also loop and reconnect routinely, so this path runs often.

`shouldRetry` is as important as the delays: an `AuthError` is **never** retried, because a rejected
cookie is still rejected thirty seconds later, and retrying it is pure noise against the gateway.

---

## 5 · Measurement, and why the header cannot be trusted

`ffprobe` on `cam01` reports, for the same stream, in the same response:

```
"r_frame_rate":   "25/1"
"avg_frame_rate": "30/1"
```

The container metadata **contradicts itself**. Measured against decoded frames, the answer is neither:

| | cam01 |
|---|---|
| Header claims | 25 fps *and* 30 fps |
| **Measured** | **~15 fps** (151 frames per 10 s of content) |
| PTS deltas observed | 0.04 s, 0.076 s, 0.08 s — **and some 0.0** |

Two independent methods agree: counting decoded frames over a known content duration, and reading
PTS deltas directly. So `measuredFps` is what goes into `camera_health_checks.measured_fps`, and
`declaredFps` is kept only so the **delta can be reported** — which is the registry's product, not
its diagnostics.

**Two consequences for downstream tickets:**

- **The 0.0 deltas are duplicate presentation timestamps.** Any tracker keyed on PTS (D1-09, D2-01)
  must tolerate non-monotonic and repeated timestamps. A velocity computed across a 0 s gap is a
  division by zero, or an infinite speed that trips impossible-transition detection (D3-02) on a
  vehicle that did nothing wrong.
- **fps is measured against the duration actually decoded**, not the requested window. Dividing by
  the requested window under-reported a genuine 10 fps clip as 6.67 fps whenever the stream was
  shorter than the sample window — and recon measured sandbox durations from 1.0 h to 24.5 h, so
  short feeds are real. That number feeds the trust score, so the bug would have quietly penalised
  cameras for being short.

---

## 6 · HLS specifics — the operational path

What the sandbox actually serves, all of it established by measurement:

| Property | Reality |
|---|---|
| Transport | HLS over **HTTPS/443**, Cloudflare-fronted. No RTSP, no WHEP |
| Playlist | `PLAYLIST-TYPE:VOD` + `ENDLIST` — finite, **seekable** |
| Size | **14,408 lines / 7,200 segments** for a 12-hour recording |
| Encryption | `#EXT-X-KEY:METHOD=AES-128`, key at `/enc.key` |
| Auth | `sentinel=` cookie required on the playlist, the key **and** every segment |
| User-Agent | **Cloudflare 403s ffmpeg's default.** A browser UA is mandatory |
| Duration | 1.0 h – 24.5 h across the estate |

Four traps, each of which produces an empty stream that looks like a broken camera:

1. **Auth must reach all three request types.** `-headers` and `-user_agent` are *input* options, so
   ffmpeg applies them to the playlist, the key and every segment. Applying auth only to the
   playlist fails at the first key fetch. A test with a local HTTP recorder asserts the cookie and
   UA arrived on `/index.m3u8`, `/enc.key` **and** `/seg0.ts`.
2. **`-ss` must come before `-i`.** Input seek jumps to the segment containing the offset; output
   seek decodes and discards everything before it. On a 12-hour playlist that is seconds versus
   hours.
3. **HTTP-only options must not reach a non-HTTP input.** Passing `-reconnect` to an RTSP URL makes
   ffmpeg exit instantly with `Option reconnect not found` — which surfaced as an RTSP stream that
   opened successfully and then produced no frames at all. `httpInputArgs` is scheme-aware, and a
   regression test covers it.
4. **A deadline is not a verdict.** The same `cam01` probe measured **27 s** on an idle gateway and
   **295 s** under load. Killing ffmpeg on a deadline and reading its partial stderr as "not
   decodable" would condemn a working camera for a slow afternoon, so a killed process raises
   `TimeoutError`.

### Seeking is a first-class capability

Seek is what makes faster-than-real-time processing possible: a 12-hour recording can be analysed in
minutes by seeking to the interesting windows rather than streaming the whole thing. Recon
established that ~9 of the 12 recorded hours are dark (the window runs 21:00 → 09:00), so daylight
sits around offsets **32400–43200 s**.

Proving a seek landed is done by **comparing frames**, not by brightness. `cam01` is a street-lit
bridge whose night footage is not dark — measured YAVG 100 at offset 0 against 138 at offset 39600.
A real difference, but nowhere near enough to rest a claim on. If a seek silently failed ffmpeg
would return the first frame of the file, so the test asserts the two frames are not
byte-identical.

---

## 7 · Local MediaMTX — how the demonstrated transports are verified

`ops/mediamtx/mediamtx.yml` defines a `saakshi-test` path that publishes a 640x360 **25 fps**
H.264 test pattern on startup, so the suite runs from a clean clone with no manual step. 25 fps is
the modal frame rate measured across the sandbox estate, so the number the tests assert is the
number the real feeds mostly produce.

```bash
docker compose up -d --wait mediamtx
npm run test -w packages/api -- adapters-mediamtx
```

**The suite fails loudly when MediaMTX is not running.** A `describe.skipIf` would let "RTSP
verified" stand on a suite that never executed, so the preflight throws with the fix in the message.

**ONVIF is the one case that needs explaining.** MediaMTX is not an ONVIF device and serves no SOAP,
so the **discovery** half runs against a mock ONVIF device the test starts — which answers
`GetProfiles` and `GetStreamUri` with a real MediaMTX RTSP URI — and the **media** half then streams
from MediaMTX for real. Both halves are exercised. Neither is exercised against the government feed,
which speaks no ONVIF at all. The mock deliberately uses **different namespace prefixes** in its two
responses, because real ONVIF devices are inconsistent about them and the parser must match on local
name.

**WHEP is verified at the signalling layer**, which is what WHEP is: the adapter POSTs an SDP offer,
receives `201 Created` with an SDP answer and a `Location` for teardown, and validates it. The media
then flows peer-to-peer to the browser — putting a WebRTC stack inside Node would place the server
in a path it is not meant to be in. `open()` therefore returns `stdout: null` by design, and D3-07's
browser client consumes the media.

---

## 8 · Commands

```bash
# Capability discovery against a real camera
npm run adapter:probe -- --camera cam01
npm run adapter:probe -- --camera cam12
npm run adapter:probe -- --camera cam01 --seek 39600     # writes a frame + reports its luma
npm run adapter:probe -- --camera saakshi-test --kind rtsp \
  --endpoint rtsp://127.0.0.1:8554/saakshi-test

# The three suites
npm run test -w packages/api -- adapters              # all of them
npm run test -w packages/api -- adapters-mediamtx     # RTSP / ONVIF / WHEP, fails if MTX is down
SENTINEL_PORTAL_COOKIE=sentinel=bogus \
  npm run test -w packages/api -- adapters-auth       # AuthError, not "camera down"
```

`adapter:probe` prints a `MISMATCH` line whenever measured fps disagrees with the header, which is
the fastest way to see Pillar 1's argument on a single camera.
