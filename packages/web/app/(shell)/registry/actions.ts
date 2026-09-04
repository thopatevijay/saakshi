'use server';

/**
 * Everything the registry screen asks the API for.
 *
 * These are **server actions**, not a route handler with hand-written fetches on the other side.
 * The reason is D1-07's rule: *"Never hand-write a fetch. Use the generated client."* A server
 * action keeps the outbound call on `apiClient(session.token)` — so the request and response shapes
 * come from the OpenAPI document — and still gives the client component end-to-end types, which a
 * `fetch('/api/…').then(r => r.json())` seam would throw away.
 *
 * The bearer token never crosses to the browser. It lives in an httpOnly cookie, is read here, and
 * is attached server-side.
 *
 * Every capability check below is a **courtesy**: the API re-checks against the signed token, so a
 * user who edits the role cookie gets a 403 rather than a write.
 */
import { revalidatePath } from 'next/cache';
import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import { UserRole, can } from '@saakshi/shared';
import {
  MAX_MAP_FEATURES,
  toCameraListQuery,
  type RegistryFilters,
} from '@/src/lib/registry/query';
import type {
  Camera,
  CameraPage,
  ImportState,
  ManualAddState,
  SyncState,
} from './types';

/**
 * A page of cameras for the map and the table.
 *
 * Follows the opaque cursor rather than constructing one — D1-02: *"Clients must round-trip it,
 * never construct it."*
 */
export async function loadCameras(filters: RegistryFilters): Promise<CameraPage> {
  const session = await getSession();
  if (session === null) return { cameras: [], capped: false, elapsedMs: 0, error: 'no session' };

  const client = apiClient(session.token);
  const started = Date.now();
  const cameras: Camera[] = [];
  let cursor: string | undefined;
  let capped = false;

  for (;;) {
    const { data, error } = await client.GET('/api/v1/cameras', {
      params: { query: toCameraListQuery(filters, cursor) },
    });
    if (error !== undefined || data === undefined) {
      return {
        cameras,
        capped,
        elapsedMs: Date.now() - started,
        error: 'The registry could not be loaded.',
      };
    }

    cameras.push(...data.data);
    if (data.nextCursor === null) break;
    if (cameras.length >= MAX_MAP_FEATURES) {
      capped = true;
      break;
    }
    cursor = data.nextCursor;
  }

  return { cameras, capped, elapsedMs: Date.now() - started, error: null };
}

async function fetchDetail(id: string) {
  const session = await getSession();
  if (session === null) return null;
  const client = apiClient(session.token);

  // Two calls, in parallel: the detail route carries metadata, latest health and the
  // declared-vs-measured delta; the trust route carries the per-signal breakdown that explains the
  // score. The drawer needs both, and neither endpoint is the other's superset.
  const [detail, trust] = await Promise.all([
    client.GET('/api/v1/cameras/{id}', { params: { path: { id } } }),
    client.GET('/api/v1/cameras/{id}/trust', { params: { path: { id }, query: { days: 7 } } }),
  ]);

  if (detail.error !== undefined || detail.data === undefined) return null;
  return { camera: detail.data, trust: trust.data ?? null };
}

/** Camera detail plus the full trust breakdown, for the drawer. `null` when it is gone. */
export async function loadCameraDetail(id: string) {
  return fetchDetail(id);
}

// ── Onboarding path 1 · bulk import ─────────────────────────────────────────────────────────────

/**
 * Bulk import a CSV or JSON file.
 *
 * The multipart body is rebuilt rather than forwarded, because the browser's `FormData` carries the
 * action's own fields too. The API's report comes back **per row** — `{received, imported, created,
 * updated, rejected[]}` — and the dialog renders every rejection with its row number and field
 * errors. Showing "3 rows failed" without saying which is the behaviour that makes an operator
 * re-upload the same broken file twice.
 */
export async function importCameras(_prev: ImportState, formData: FormData): Promise<ImportState> {
  const session = await getSession();
  if (session === null) return { report: null, error: 'Your session has expired.' };
  if (!can(UserRole.parse(session.user.role), 'registry:import')) {
    return { report: null, error: 'Your role may not import cameras.' };
  }

  const file = formData.get('file');
  if (!(file instanceof File) || file.size === 0) {
    return { report: null, error: 'Choose a CSV or JSON file to import.' };
  }

  const body = new FormData();
  body.append('file', file, file.name);

  const { data, error, response } = await apiClient(session.token).POST('/api/v1/cameras/bulk', {
    // openapi-fetch must not set a JSON content type: the boundary has to come from FormData.
    body: body as unknown as never,
  });

  if (error !== undefined || data === undefined) {
    return {
      report: null,
      error: `The import was rejected (HTTP ${String(response.status)}). Check the file is CSV or JSON.`,
    };
  }

  revalidatePath('/registry');
  return { report: data, error: null };
}

// ── Onboarding path 2 · manual add ──────────────────────────────────────────────────────────────

function text(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(formData: FormData, name: string): string | undefined {
  const value = text(formData, name);
  return value === '' ? undefined : value;
}

function numeric(formData: FormData, name: string): number | undefined {
  const value = optional(formData, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Onboard one camera by hand — the path a department uses for a single new installation. */
export async function addCamera(
  _prev: ManualAddState,
  formData: FormData,
): Promise<ManualAddState> {
  const session = await getSession();
  if (session === null) return { created: null, error: 'Your session has expired.' };
  if (!can(UserRole.parse(session.user.role), 'registry:write')) {
    return { created: null, error: 'Your role may not add cameras.' };
  }

  const externalId = text(formData, 'externalId');
  const name = text(formData, 'name');
  if (externalId === '' || name === '') {
    return { created: null, error: 'A camera id and a name are required.' };
  }

  const adapterKind = text(formData, 'adapterKind');
  const endpoint = optional(formData, 'endpoint');

  const { data, error, response } = await apiClient(session.token).POST('/api/v1/cameras', {
    body: {
      externalId,
      name,
      adapterKind: (adapterKind === '' ? 'hls' : adapterKind) as 'hls',
      cameraType: (optional(formData, 'cameraType') ?? 'ip') as 'ip',
      mount: (optional(formData, 'mount') ?? 'static') as 'static',
      geometryClass: (optional(formData, 'geometryClass') ?? 'unclassified') as 'unclassified',
      endpoints: endpoint === undefined ? {} : { primary: endpoint },
      // `null` rather than omitted: the contract accepts nullable, and an unfilled field means
      // "we do not know", which is a fact worth storing rather than a key to leave off.
      lat: numeric(formData, 'lat') ?? null,
      lon: numeric(formData, 'lon') ?? null,
      district: optional(formData, 'district') ?? null,
      address: optional(formData, 'address') ?? null,
      retentionDays: numeric(formData, 'retentionDays') ?? null,
      declaredResolution: optional(formData, 'declaredResolution') ?? null,
      declaredFps: numeric(formData, 'declaredFps') ?? null,
    },
  });

  if (error !== undefined || data === undefined) {
    return {
      created: null,
      error:
        response.status === 409
          ? `A camera with the id ${externalId} already exists.`
          : `The camera was rejected (HTTP ${String(response.status)}). Check the fields and try again.`,
    };
  }

  revalidatePath('/registry');
  return { created: { externalId: data.externalId, id: data.id }, error: null };
}

// ── Onboarding path 3 · catalogue sync ──────────────────────────────────────────────────────────

/**
 * Pull the upstream catalogue.
 *
 * This reaches the sandbox gateway, so it is an explicit operator action and never something the
 * screen does on load. A failed run is still persisted by the job and readable at
 * `GET /api/v1/sync/reports`, which is why the error path says to look there.
 */
export async function syncCatalogue(): Promise<SyncState> {
  const session = await getSession();
  if (session === null) return { report: null, error: 'Your session has expired.' };
  if (!can(UserRole.parse(session.user.role), 'registry:import')) {
    return { report: null, error: 'Your role may not run a catalogue sync.' };
  }

  const { data, error } = await apiClient(session.token).POST(
    '/api/v1/cameras/onboard-from-catalogue',
    { body: { adapterKind: 'hls' } },
  );

  if (error !== undefined || data === undefined) {
    return {
      report: null,
      error:
        'The catalogue sync failed. The run is recorded either way — see GET /api/v1/sync/reports for the raw payload.',
    };
  }

  revalidatePath('/registry');
  return { report: data, error: null };
}
