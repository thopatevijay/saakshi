---
title: "D1-03 · Adapter framework: RTSP, ONVIF, HLS, WHEP, NVR stub"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "backend", "pillar-2", "model-3-core"]
blocked_by: ["D0-01", "D1-01"]
estimate: "3h"
---

## Context

This is the heart of the Model 3 federation argument: **onboarding a new vendor must be writing an
adapter, never touching the core.** If a judge asks "how do you add a new department's VMS?", the
answer is this interface and a 100-line file.

## Scope

```ts
interface CameraAdapter {
  kind: 'rtsp' | 'onvif' | 'hls' | 'whep' | 'nvr-file';
  probe(cfg: CameraConfig): Promise<CameraCapabilities>;  // codec, res, measured fps, audio, ptz
  open(cfg: CameraConfig): Promise<StreamHandle>;
  close(h: StreamHandle): Promise<void>;
  health(cfg: CameraConfig): Promise<HealthSample>;
}
```

- Registry of adapters, resolved by `cameras.adapter_kind`
- `probe()` is the **capability discovery** step: never trust declared metadata, measure it
- RTSP adapter **forces TCP** (`rtsp_transport=tcp`); falls back to HLS if 8554 is unreachable
- ONVIF adapter: device discovery + profile → stream URI (a real implementation, not a stub)
- HLS + WHEP adapters for browser paths
- `nvr-file` stub with the interface implemented and a documented "what a real NVR needs" note
- MediaMTX used as the relay target so one adapter can republish RTSP → HLS/WHEP for the video wall
- Adapter-level retry with **exponential backoff, 2 s → 30 s cap**, never a tight loop

## Out of scope

- Inference (D1-09 / D2-01)
- The video wall UI (D3-06)

## Acceptance Criteria

- [ ] All five adapters implement the interface; `nvr-file` is honestly documented as a stub
- [ ] `probe()` returns **measured** fps, actual codec, actual resolution — and flags divergence
      from declared values
- [ ] RTSP adapter proven to force TCP (assert on the ffmpeg/GStreamer options actually used)
- [ ] HLS fallback triggers automatically when RTSP/8554 is blocked (test with a blocked port)
- [ ] Reconnect backoff verified: kill a feed, confirm 2s/4s/8s/16s/30s/30s… and successful recovery
- [ ] Adding a sixth adapter requires **zero changes** outside its own file + one registry line —
      demonstrated with a throwaway `null` adapter in a test
- [ ] Unit tests per adapter; integration test against ≥2 real sandbox cameras of different codecs

## Deliverables

- `packages/api/src/adapters/{index,rtsp,onvif,hls,whep,nvr-file}.ts`
- `docs/adapter-framework.md` — the interface contract + a "write your own adapter in 20 lines" guide
  (this doubles as the HLD's extensibility section)

## Validation Gate

```bash
npm run test -w packages/api -- adapters
npm run adapter:probe -- --camera <demo-id-1>   # H.264 camera
npm run adapter:probe -- --camera <demo-id-2>   # H.265 camera
```

- [ ] Both probes return measured capabilities and divergence flags
- [ ] Backoff test passes
- [ ] The "sixth adapter" extensibility test passes

## Handoff → D1-05, D1-09, D3-06

Publish `CameraCapabilities` shape as a comment. The prober and analytics worker both consume it.
