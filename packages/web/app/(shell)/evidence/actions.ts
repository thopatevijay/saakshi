'use server';

/**
 * Everything the evidence clock asks the API for.
 *
 * Server actions rather than a browser `fetch`, for D1-07's reason: the bearer token lives in an
 * httpOnly cookie and never crosses to the client.
 *
 * **An empty covering set is an answer, not an error.** On the sandbox estate it is *the* answer —
 * no camera in the Gujarat catalogue carries coordinates, so nothing can be shown to have covered
 * anywhere. The screen renders that plainly, together with the count of cameras that could be ruled
 * neither in nor out, rather than an empty table that reads as "no cameras were there".
 */
import { revalidatePath } from 'next/cache';
import { apiClient } from '@/src/lib/api/client';
import { getSession } from '@/src/lib/session';
import type { AvailabilityQueryState, EvidenceView, PreservationFormState } from './types';

const EXPIRED_SESSION = 'Your session has expired. Sign in again.';

export async function loadEvidence(query: AvailabilityQueryState): Promise<EvidenceView> {
  const session = await getSession();
  if (session === null) {
    return { availability: null, summary: null, queue: null, error: EXPIRED_SESSION, elapsedMs: 0 };
  }

  const client = apiClient(session.token);
  const started = Date.now();

  const lat = Number(query.lat);
  const lon = Number(query.lon);
  const askable = query.lat !== '' && query.lon !== '' && !Number.isNaN(lat) && !Number.isNaN(lon);

  const [availability, summary, queue] = await Promise.all([
    askable
      ? client.GET('/api/v1/evidence/availability', {
          params: {
            query: {
              lat,
              lon,
              radius_m: query.radiusM === '' ? 500 : Number(query.radiusM),
              ...(query.at === '' ? {} : { at: new Date(query.at).toISOString() }),
              ...(query.expiringSoonHours === ''
                ? {}
                : { expiring_soon_hours: Number(query.expiringSoonHours) }),
            },
          },
        })
      : Promise.resolve(null),
    client.GET('/api/v1/evidence/retention/summary', {}),
    client.GET('/api/v1/evidence/preservation', { params: { query: { limit: 50 } } }),
  ]);

  const elapsedMs = Date.now() - started;

  const failed = [availability, summary, queue].find(
    (result) => result !== null && result.data === undefined,
  );
  const error =
    failed === undefined || failed === null
      ? null
      : failed.response.status === 403
        ? 'Your role may not read the camera registry.'
        : `The evidence clock could not be read (HTTP ${String(failed.response.status)}).`;

  return {
    availability: availability?.data ?? null,
    summary: summary.data ?? null,
    queue: queue.data ?? null,
    error,
    elapsedMs,
  };
}

/**
 * Record a preservation request.
 *
 * The API is authoritative on who may do this (`WRITE_ROLES`) and on the shape of a case reference;
 * this action exists so an officer sees a sentence rather than a 400 they have to interpret.
 */
export async function requestPreservation(
  _previous: PreservationFormState,
  form: FormData,
): Promise<PreservationFormState> {
  const session = await getSession();
  if (session === null) return { ok: false, message: EXPIRED_SESSION, auditHash: null };

  /** `FormData.get` can return a `File`; a `File` in any of these fields is not a value we want. */
  const field = (name: string): string => {
    const value = form.get(name);
    return typeof value === 'string' ? value.trim() : '';
  };

  const cameraId = field('cameraId');
  const caseRef = field('caseRef');
  const purpose = field('purpose');
  const windowStart = field('windowStart');
  const windowEnd = field('windowEnd');

  if (cameraId === '' || caseRef === '' || purpose === '' || windowStart === '' || windowEnd === '') {
    return {
      ok: false,
      message: 'Camera, case reference, purpose and both ends of the window are all required.',
      auditHash: null,
    };
  }

  const { data, response } = await apiClient(session.token).POST('/api/v1/evidence/preservation', {
    body: {
      cameraId,
      caseRef,
      purpose,
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
    },
  });

  if (data === undefined) {
    const message =
      response.status === 403
        ? 'Your role may not raise a preservation request. Ask a supervisor.'
        : response.status === 404
          ? 'That camera is not in the registry.'
          : response.status === 400
            ? 'The request was refused: check the case reference and that the window runs forwards.'
            : `The request could not be recorded (HTTP ${String(response.status)}).`;
    return { ok: false, message, auditHash: null };
  }

  revalidatePath('/evidence');
  return {
    ok: true,
    message:
      `Recorded against ${data.request.caseRef} and appended to the audit chain. ` +
      `It is now on the queue for ${data.request.departmentName ?? 'the owning department'} to act on.`,
    auditHash: data.auditHash,
  };
}
