---
title: "D2-05 · Watchlist service: provider interface, mock provider, seed data"
milestone: "Day 2 — Analytics & Alert Core"
labels: ["day-2", "backend", "pillar-4", "compliance"]
blocked_by: ["D1-01"]
estimate: "2.5h"
---

## Context

The problem statement is explicit: *"Participants may create and use their own representative
watchlist database."* **There is no live VAHAN / SARTHI / eGujCop / AFIS / NAFIS access.**

So the honest engineering position is: build the integration *interface* and specify each connector
precisely, ship a mock provider with representative data, and **never claim live connectivity**. Any
team claiming otherwise is lying, and the jury includes the people who own those systems.

## Scope

```ts
interface WatchlistProvider {
  system: 'VAHAN'|'SARTHI'|'eGujCop'|'AFIS'|'NAFIS'|'manual';
  lookupVehicle(plateNormalized: string): Promise<WatchlistHit[]>;
  lookupPerson(ref: string): Promise<WatchlistHit[]>;
  sync(since?: Date): Promise<SyncResult>;   // bulk pull into watchlist_entries
  health(): Promise<ProviderHealth>;
}
```

- `MockProvider` backed by `watchlist_entries`, seeded with a representative dataset
- Field shapes modelled on the **real** systems so a live integration is a connector swap:
  - VAHAN → vehicle: registration no., make, model, colour, owner ref, RC status
  - SARTHI → driver: DL no., name, validity
  - eGujCop (CCTNS) → FIR ref, wanted status, stolen-vehicle record, missing person
  - AFIS/NAFIS → subject **reference only**; we process no biometrics
- Categories: `stolen_vehicle · wanted_person · missing_person · blacklisted_vehicle · suspect`
- Validity windows (`valid_from`/`valid_to`) honoured — an expired entry must not alert
- CRUD API + CSV bulk import for watchlist entries
- Seed: ≥ 200 entries including **at least 5 plates that genuinely appear on the sandbox feeds**
  (from D0-01/D2-01 observations) so the live demo produces real hits

## Acceptance Criteria

- [ ] Interface defined; `MockProvider` fully implements it
- [ ] A second provider can be registered with **zero core changes** (proven with a `null` provider test)
- [ ] Seed dataset ≥ 200 entries across all five categories
- [ ] ≥ 5 seeded plates verifiably appear on the sandbox feeds — **listed as a comment**
- [ ] Expired entries never match (validity-window test at the boundary)
- [ ] Vehicle lookup accepts normalised plates and integrates the D2-04 fuzzy matcher
- [ ] AFIS/NAFIS providers documented as reference-only; **no biometric field is ever populated**
- [ ] CRUD + bulk import work; RBAC enforced (operator cannot mutate the watchlist)
- [ ] Every lookup writes an `audit_log` row with a purpose

## Deliverables

- `packages/api/src/watchlist/{provider,mock-provider,index}.ts`
- `fixtures/watchlist-seed.csv`
- `docs/watchlist-integration.md` — **the connector specification per system**: endpoints needed,
  auth model, field mapping, sync cadence, rate limits, and exactly what Gujarat Police would have to
  provide. This document is the "integration-ready" proof, and it is scored under
  *Department-wise Information Requirements*.

## Validation Gate

```bash
npm run test -w packages/api -- watchlist
npm run seed:watchlist
psql $DATABASE_URL -c "select category, count(*) from watchlist_entries group by 1;"
curl -fsS "localhost:4000/api/v1/watchlist/lookup/vehicle/<seeded-plate>" | jq
psql $DATABASE_URL -c "select count(*) from audit_log where action like 'watchlist%';"
```

- [ ] All five categories populated; validity boundary test green
- [ ] `docs/watchlist-integration.md` complete per system

## Handoff → D2-06

Publish the `WatchlistHit` shape. The alert engine consumes it directly.
