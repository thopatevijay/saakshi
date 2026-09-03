---
title: "D1-07 · Web shell: Next.js app, auth, RBAC, layout"
milestone: "Day 1 — Registry & Ingest Foundation"
labels: ["day-1", "frontend"]
blocked_by: ["D1-01"]
estimate: "2.5h"
---

## Context

"Working Platform and Demonstration" is a scored area judged on **maturity**. This is the frame every
later screen hangs on, and it is where a full-stack advantage shows against CV-first teams. It must
look like an operational system, not a hackathon dashboard.

## Scope

- Next.js 15 App Router, Tailwind, dark control-room-appropriate theme
- Session auth against `users` (JWT httpOnly cookie); login screen
- RBAC in the UI: `admin · supervisor · operator · auditor` — nav and actions gated by role
- App shell: left nav (Registry · Video Wall · Trace · Alerts · Audit · Sizing), header with
  role/badge, global camera search
- Server-side data fetching via typed client generated from the OpenAPI spec (no hand-written fetch)
- Loading/empty/error states as first-class components, not afterthoughts
- Toast + confirm patterns for mutating actions

## Out of scope

- Any individual feature screen beyond the Registry stub (D1-08)

## Acceptance Criteria

- [ ] Login works for all four seeded roles; bad credentials handled cleanly
- [ ] Auditor sees Audit but cannot reach Registry mutations; operator sees read-only Registry —
      enforced client **and** server side (server is authoritative)
- [ ] Direct-URL access to a forbidden route redirects, not 500s
- [ ] Typed API client generated from OpenAPI; zero `any` in `packages/web`
- [ ] Every route has explicit loading, empty, and error states
- [ ] Lighthouse accessibility ≥ 90 on the login and shell routes
- [ ] Responsive at 1280px and 1920px (control-room displays)

## Deliverables

- `packages/web/` app shell, auth, RBAC guard, generated API client
- `docs/rbac.md` — the role × capability matrix (feeds the HLD security section)

## Validation Gate

```bash
npm run typecheck -w packages/web && npm run lint -w packages/web
npm run test -w packages/web
npm run build -w packages/web     # production build must succeed
```

- [ ] Manual: log in as each of the four roles and confirm the nav/permission differences
- [ ] Server-side denial verified with curl using an operator token against a supervisor endpoint

## Handoff → D1-08 and every later UI ticket

Publish the layout slots and the generated-client import path as a comment.
