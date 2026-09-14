---
title: "D4-12 · Three backlog defects a judge can see: unpinned times, an open database port, and a message that blames the estate"
milestone: "Day 4 — Deploy & Submit"
labels: ["day-4", "bug", "security", "submission"]
blocked_by: []
estimate: "1h"
---

## Context

A re-triage of `BL-01` on 14 Sep, after D4-09/10/11 closed the rest. Three findings survive, all
confirmed present on `main`, all small, and two of them visible to a judge.

**1 · `alerts/present.ts` formats times with a locale but no time zone** (BL-01 finding 8).
`packages/web/src/lib/alerts/present.ts:304,310` call `toLocaleTimeString('en-GB', …)` and
`toLocaleDateString('en-GB', …)` with no `timeZone`. D3-14 established the rule for this codebase
after an unpinned `toLocaleString()` threw a hydration error and froze `/trace` for a second:
**import from `@/src/lib/time`; never call a `toLocale*` on a date without both a locale and a
`timeZone`.** These two were left alone at the time because the alert queue renders client-side only,
so there is no mismatch *today*. Two consequences stand regardless:

- Two officers in different time zones read **different times off the same alert**, which is a
  correctness bug in an evidence product, not a formatting preference.
- It becomes a live hydration failure the moment any of it is server-rendered — and the fix for that
  class is invisible on a developer laptop and appears on a UTC container.

**2 · Every compose service binds `0.0.0.0`, with credentials published in this repository**
(BL-01, 11 Sep). All seven published ports lack a `127.0.0.1:` prefix: Postgres `saakshi/saakshi`,
Valkey with no auth, MinIO `saakshi/saakshi-dev-secret`, Grafana `admin/admin`, Prometheus with no
auth. Every one of those pairs is in this repo.

The **Grand Finale is in person at i-Hub Gujarat, 22–23 Sep**, on shared venue wifi, with the demo
running on a laptop in the room. That is precisely where an open `0.0.0.0:5432` carrying an evidence
database — audit chain, MinIO crops of real vehicles — stops being theoretical. The irony is sharp
for a project whose pitch is chain of custody and purpose-bound access.

**3 · The impossible-transition sweep blames the estate for a fault in the router**
(BL-01, from D4-10). With no evaluable segment it prints:

> `54 of 85 cameras carry coordinates, so no road distance exists between any pair and no travel
> time can be required of one.`

That sentence is **self-contradictory once any camera is placed**, and it points at the camera
catalogue when the actual cause may be an unreachable OSRM or a poisoned route cache — which is
exactly what happened during D4-10 and cost an hour. **`docs/judge-walkthrough.md` quotes this output
to the screening committee**, and the deployment is the instance where this branch fires.

## Scope

- Pin both `alerts/present.ts` formatters to `ESTATE_TIME_ZONE` via `@/src/lib/time`, and update the
  alert-queue tests that consume their output
- Bind every compose port to `127.0.0.1` **except** where LAN reach is a deliberate requirement.
  MediaMTX is the one to think about rather than change blindly: 8554/8889/8888 may legitimately need
  to be reachable if a phone or a second machine is ever used as a camera source
- Rewrite the sweep's zero-evaluable interpretation so it distinguishes **"no camera pair is placed"**
  from **"no segment carries a road distance"**, and names the router as a candidate cause. Do not
  weaken the honest refusal — `"0 impossible transitions" here means "0 transitions were testable"`
  must survive, because that sentence is a scoring asset

## Acceptance Criteria

- [ ] No `toLocale*` call on a date anywhere in `packages/web/src` lacks both a locale and a
      `timeZone` — proven by a search, not by inspection
- [ ] The alert queue renders identical times under `TZ=UTC` and `TZ=Asia/Kolkata`
- [ ] `docker compose config` resolves, the stack comes up healthy, and Postgres/Valkey/MinIO/
      Grafana/Prometheus are **not reachable from another host on the LAN** — evidenced by the
      published bind addresses, not by assertion
- [ ] Any port left on `0.0.0.0` has a stated reason in the compose file
- [ ] With zero evaluable segments the sweep's text no longer asserts a causal link from the camera
      count, and names the road graph / router as a candidate cause
- [ ] With evaluable segments the existing measured verdict is unchanged
- [ ] The `"0 transitions were testable"` refusal is still present

## Validation Gate

```bash
npm run test && npm run typecheck && npm run lint
docker compose config | grep -E 'published|0\.0\.0\.0' || true
npm run analyze:anomalies
```

- [ ] Suite green, compose bindings loopback, sweep text accurate in both branches
