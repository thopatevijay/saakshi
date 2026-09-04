# Roles and capabilities

Four roles, twelve capabilities, one matrix. This document is the security section the HLD (D4-05)
quotes; the matrix it describes lives in **`packages/shared/src/rbac.ts`** and is imported by the
API, the web shell and the tests, so the three cannot drift into disagreeing about who may do what.

## The rule that matters

> **The server is authoritative. Client-side gating is a courtesy, never a boundary.**

There are three layers, and only one of them is a security control:

| Layer | What it does | Is it a control? |
|---|---|---|
| **Nav** (`navFor(role)`) | Hides destinations a role cannot use | **No.** A convenience so nobody walks into a 403. |
| **Middleware** (`capabilityForPath`) | Redirects a forbidden direct URL to `/forbidden` | **No.** It reads a *readable* role cookie, which the user can edit. |
| **API** (`requireRole`) | Refuses the request, 403 | **Yes.** It verifies a signed JWT and checks the subject against `users WHERE active`. |

The role cookie is deliberately readable so middleware can gate a navigation without a network round
trip. **Editing it buys a menu item and a 403** — the request the page then makes still carries the
original signed token, and the API decides. A test asserts exactly this
(`an escalated role gets the page but the API still decides the data`).

## The four roles

| Role | Badge (seed) | Purpose |
|---|---|---|
| `admin` | `GP-ADM-0001` | Full control: registry, onboarding, retention policy. **The only role that may delete.** |
| `supervisor` | `GP-SUP-0100` | Approves exports and escalations; may onboard cameras but never decommission one. |
| `operator` | `GP-OPR-1042` | The control-room seat: watch, verify, acknowledge. **Read-only on the registry.** |
| `auditor` | `GP-AUD-0007` | Read-only across the audit chain. |

## The matrix

| Capability | admin | supervisor | operator | auditor |
|---|:---:|:---:|:---:|:---:|
| `registry:read` | ✅ | ✅ | ✅ | ✅ |
| `registry:write` | ✅ | ✅ | — | — |
| `registry:import` | ✅ | ✅ | — | — |
| `registry:delete` | ✅ | — | — | — |
| `trust:read` | ✅ | ✅ | ✅ | ✅ |
| `video:view` | ✅ | ✅ | ✅ | — |
| `trace:run` | ✅ | ✅ | ✅ | — |
| `alerts:view` | ✅ | ✅ | ✅ | — |
| `alerts:acknowledge` | ✅ | ✅ | ✅ | — |
| `audit:read` | ✅ | ✅ | — | ✅ |
| `audit:export` | ✅ | ✅ | — | ✅ |
| `sizing:use` | ✅ | ✅ | ✅ | — |

### Two cells that are decisions, not oversights

**`registry:delete` is admin-only.** A decommissioned camera is still the provenance of every
sighting and every alert already attached to it, so deletion is *soft* and the row never goes. Even
so, the act of retiring a camera from the estate is an administrative decision, not a supervisory
one. This mirrors the API D1-02 shipped: *"read = all four roles; create/update/import =
admin+supervisor; delete = admin only."*

**The auditor has no `video:view` and no `trace:run`.** An auditor who can change the thing being
audited is not an auditor — but the exclusion goes further than write access. The audit function
examines *what was done*: who ran which query, against which camera, for what stated purpose. It does
not require watching the footage. Granting live video and vehicle tracing to a read-only role would
widen the surveillance surface without serving any audit purpose, so it is withheld deliberately.
The auditor keeps `registry:read` and `trust:read` because *"was this camera even working when the
system claims it saw something"* is an audit question.

## Route guard

| Route | Capability |
|---|---|
| `/registry` | `registry:read` |
| `/video-wall` | `video:view` |
| `/trace` | `trace:run` |
| `/alerts` | `alerts:view` |
| `/audit` | `audit:read` |
| `/sizing` | `sizing:use` |
| `/login`, `/forbidden` | public |

A path not listed is reachable by any signed-in role. Prefix matching is exact-segment: `/registry`
guards `/registry/cam01` but **not** `/registry-archive`, which a naive `startsWith` would have
captured. A test covers that.

## Sessions

| | |
|---|---|
| Issued by | `POST /api/v1/auth/login` — the only route in the API that creates a token rather than verifying one |
| Credential check | **In PostgreSQL**: `password_hash = crypt($password, password_hash)`, pgcrypto bcrypt. The hash never enters application memory and the deploy carries no native crypto dependency. |
| Lifetime | 12 hours — a control-room shift, not a week |
| Token cookie | `saakshi_session`, **httpOnly**, `SameSite=Lax`, `Secure` in production. Browser JavaScript cannot read it, so an XSS in any dependency cannot exfiltrate a session. |
| Role cookie | `saakshi_role`, readable, middleware-only. A hint, never an authority. |
| Revocation | `authenticate(db)` checks the subject against `users WHERE active` on **every** request, so deactivating an officer genuinely revokes access rather than leaving a cryptographically valid token working. |

### Failed login is deliberately uninformative

An unknown badge, a deactivated account and a wrong password all return the **identical**
`401 {"error":"unauthorized","message":"badge number or password is incorrect"}`. Distinguishing them
would turn the endpoint into an oracle for valid badge numbers — a test asserts the three responses
are byte-identical.

## Verifying it

```bash
# Server-side denial: an operator token against a supervisor-only endpoint.
TOKEN=$(curl -fsS -X POST localhost:4000/api/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"badgeNo":"GP-OPR-1042","password":"saakshi-dev"}' | jq -r .token)

curl -s -o /dev/null -w '%{http_code}\n' -X POST localhost:4000/api/v1/cameras \
  -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"externalId":"X","name":"X","adapterKind":"hls"}'
# → 403 {"error":"forbidden","message":"role 'operator' may not perform this action",
#         "allowed":["admin","supervisor"]}
```

`npm run test -w packages/web` covers the matrix, the nav, the route guard and the middleware
redirects; `npm run test -w packages/api -- auth` covers issuance, revocation and the server-side
denials.
