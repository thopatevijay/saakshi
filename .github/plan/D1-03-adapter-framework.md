---
title: "D1-03 · Adapter framework: HLS primary, RTSP/ONVIF/WHEP/NVR"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "backend", "pillar-2", "model-4-core"]
blocked_by: ["D0-01", "D1-01"]
estimate: "3h"
---

## Context

This is the heart of **Model 4's "System Architecture & Integration Depth" (25 marks)**: onboarding a
new vendor must be writing an adapter, never touching the core. The rubric scores how well the
solution integrates cameras, the registry (M1) and the control room (M2) into one maintainable
ecosystem — this interface is that integration. If a judge asks "how do you add a new department's VMS?", the
answer is this interface and a 100-line file.

**Reality check from D0-01 (full detail in `BL-01`):** the deployed sandbox is **HLS-only**. There is
no RTSP on `:8554` and no WHEP on `:8889`, despite the Integrator's Guide describing both. The
streams are VOD HLS (`PLAYLIST-TYPE:VOD` + `ENDLIST`, seekable), AES-128 encrypted, behind a
`sentinel=<token>` cookie, and Cloudflare rejects ffmpeg's default User-Agent.

So the priority inverts: **HLS is the operational path; RTSP/ONVIF/WHEP are the federation
demonstration.** They must still be genuinely implemented and tested — against a local MediaMTX
instance — because the vendor-neutrality claim has to be real. **Never present them as working
against the government feed when they are not.**

*Open question (D0-02):* whether a separate RTSP/live environment appears for evaluation. If it does,
the RTSP adapter becomes operational with no core change — which is precisely the point of this
design. Say that in the deck.

## Scope

```ts
interface CameraAdapter {
  kind: 'hls' | 'rtsp' | 'onvif' | 'whep' | 'nvr-file';
  probe(cfg: CameraConfig): Promise<CameraCapabilities>;  // codec, res, measured fps, duration
  open(cfg: CameraConfig): Promise<StreamHandle>;
  close(h: StreamHandle): Promise<void>;
  health(cfg: CameraConfig): Promise<HealthSample>;
}
```

- Registry of adapters resolved by `cameras.adapter_kind`
- **`probe()` is capability discovery.** The catalogue declares only `{id,name}` — no codec, fps,
  resolution, or location. Everything must be measured. This is the strongest possible version of
  Pillar 1's "measure, don't trust declared metadata": there is no declared metadata to trust.
- **HLS adapter (primary)** — must handle, and be tested for:
  - AES-128 encrypted segments (ffmpeg resolves `/enc.key` transparently)
  - **Auth header injection** (`Cookie: sentinel=…`) on playlist, key **and** segment requests
  - **Browser User-Agent** — Cloudflare 403s ffmpeg's default; this is not optional
  - VOD semantics: seekable, finite, `ENDLIST` present. **Seeking to an offset is a first-class
    capability** — it is what makes faster-than-real-time processing possible
  - Cookie expiry surfaced as a clear auth error, never as "camera down"
- **RTSP adapter** — forces TCP (`rtsp_transport=tcp`); tested against local MediaMTX
- **ONVIF adapter** — device discovery + profile → stream URI; tested against local MediaMTX
- **WHEP adapter** — browser path for low-latency preview; tested against local MediaMTX
- **`nvr-file` stub** — interface implemented, honestly documented as a stub
- Adapter-level retry with **exponential backoff, 2 s → 30 s cap**, never a tight loop

## Out of scope

- Inference (D1-09 / D2-01); the video wall UI (D3-07)

## Acceptance Criteria

- [ ] All five adapters implement the interface; `nvr-file` is documented as a stub
- [ ] **HLS adapter works against the real sandbox**: probes ≥ 2 cameras of differing resolution
      (`cam01` 1920x1080 and `cam12` 1280x720) and returns measured codec/resolution/fps/duration
- [ ] HLS adapter seeks to an arbitrary offset and returns frames from that point (proves
      faster-than-real-time processing is available)
- [ ] Auth headers and browser UA applied to playlist, key and segment requests — asserted on the
      actual ffmpeg argv, not assumed
- [ ] Expired/missing cookie produces a distinct `AuthError`, **not** a generic "camera unreachable"
      (regression test with a deliberately bad cookie)
- [ ] RTSP, ONVIF and WHEP adapters verified against **local MediaMTX**, with a test that fails
      loudly if MediaMTX is not running (so a silent skip cannot masquerade as a pass)
- [ ] Reconnect backoff verified: interrupt a stream, confirm 2s/4s/8s/16s/30s/30s… and recovery
- [ ] Adding a sixth adapter requires **zero changes** outside its own file plus one registry line —
      demonstrated with a throwaway `null` adapter in a test
- [ ] `CameraCapabilities` includes a `transport` field so the registry records how each camera is
      actually reachable, and the UI can show it

## Deliverables

- `packages/api/src/adapters/{index,hls,rtsp,onvif,whep,nvr-file}.ts`
- `ops/mediamtx/` — local config + a seeded loop source, so RTSP/ONVIF/WHEP tests are reproducible
- `docs/adapter-framework.md` — the interface contract, a "write your own adapter in 20 lines"
  guide, and **an explicit table of which transports are operational against the sandbox versus
  demonstrated against MediaMTX.** That table is the honesty guarantee; it goes in the HLD verbatim.

## Validation Gate

```bash
set -a; . ./.env; set +a
npm run test -w packages/api -- adapters
npm run adapter:probe -- --camera cam01     # 1920x1080
npm run adapter:probe -- --camera cam12     # 1280x720
npm run adapter:probe -- --camera cam01 --seek 39600    # daylight offset
docker compose up -d mediamtx && npm run test -w packages/api -- adapters-mediamtx
SENTINEL_PORTAL_COOKIE=sentinel=bogus npm run test -w packages/api -- adapters-auth   # AuthError
```

- [ ] Both probes return measured capabilities differing in resolution
- [ ] Seek probe returns a daylight frame
- [ ] MediaMTX suite passes and fails loudly when MediaMTX is down
- [ ] Bad-cookie test yields `AuthError`
- [ ] Backoff and sixth-adapter extensibility tests pass

## Handoff → D1-04, D1-05, D1-09, D3-07

Publish the `CameraCapabilities` shape and the operational-vs-demonstrated transport table as a
comment. The prober, the analytics worker and the video wall all consume them.
