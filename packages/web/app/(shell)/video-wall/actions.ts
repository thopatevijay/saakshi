'use server';

/**
 * Everything the wall asks the API for that is not a media byte.
 *
 * Server actions, not hand-written fetches — D1-07's rule, and the same reasoning as the registry's
 * `actions.ts`: the outbound call goes through `apiClient(session.token)`, so request and response
 * shapes come from the OpenAPI document and the bearer never crosses to the browser.
 *
 * Media is the deliberate exception. A `<video>` element and `hls.js` fetch for themselves, so
 * playlists and segments go through the same-origin route handler in `stream/[...path]/route.ts`,
 * which is the only other place this screen reaches the API.
 */
import { getSession } from '@/src/lib/session';
import { apiClient } from '@/src/lib/api/client';
import type { WallLayout } from '@/src/lib/wall/layout';
import type { StreamManifest, WallCamera } from './types';

/** The estate, for the picker and for the default wall. */
export async function loadWallCameras(): Promise<WallCamera[]> {
  const session = await getSession();
  if (session === null) return [];

  const cameras: WallCamera[] = [];
  let cursor: string | undefined;

  for (;;) {
    const { data, error } = await apiClient(session.token).GET('/api/v1/cameras', {
      params: { query: { limit: 200, ...(cursor === undefined ? {} : { cursor }) } },
    });
    if (error !== undefined || data === undefined) break;

    cameras.push(
      ...data.data.map((camera) => ({
        id: camera.id,
        externalId: camera.externalId,
        name: camera.name,
        departmentCode: camera.departmentCode,
        district: camera.district,
        band: camera.band,
        trustScore: camera.trustScore,
      })),
    );
    if (data.nextCursor === null) break;
    cursor = data.nextCursor;
    // A wall picker is a list a human scrolls. Three pages is already more than anyone reads, and
    // the registry screen is the right place to search 100,000 cameras.
    if (cameras.length >= 600) break;
  }

  return cameras;
}

export async function loadManifest(cameraId: string): Promise<StreamManifest | null> {
  const session = await getSession();
  if (session === null) return null;
  const { data, error } = await apiClient(session.token).GET('/api/v1/streams/{id}/manifest', {
    params: { path: { id: cameraId } },
  });
  return error !== undefined || data === undefined ? null : data;
}

export async function loadLayout(): Promise<WallLayout | null> {
  const session = await getSession();
  if (session === null) return null;
  const { data, error } = await apiClient(session.token).GET('/api/v1/wall/layout');
  return error !== undefined || data === undefined ? null : data.layout;
}

/**
 * Save the wall.
 *
 * Fire-and-forget from the client's point of view — a failed save must never interrupt an operator
 * watching a junction. It returns a boolean so the toolbar can show that the last save did not
 * land, rather than silently pretending it did.
 */
export async function saveLayout(layout: WallLayout): Promise<boolean> {
  const session = await getSession();
  if (session === null) return false;
  const { error } = await apiClient(session.token).PUT('/api/v1/wall/layout', { body: layout });
  return error === undefined;
}
