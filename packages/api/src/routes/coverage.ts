/**
 * Coverage overlay for the registry map (D3-06).
 *
 * One GeoJSON polygon per placed camera, tagged with the state the map colours by. It is served
 * live rather than shipped as a static file so the overlay reflects a trust change the moment the
 * band moves — the same property AC 8 asks of the report generator.
 *
 * **The third state is not in this payload, and that is deliberate.** "Uncovered" is drawn as the
 * absence of a cell over the basemap's own road layers. Shipping 540,584 uncovered ways to a
 * browser to colour them grey would cost tens of megabytes to render a negative, and the report
 * says plainly that uncovered is rendered as absence so a reader can check the claim.
 */
import { z } from 'zod';
import type { App } from '../server.js';
import { authenticate, READ_ROLES, requireRole } from '../auth.js';
import type { Db } from '../db/client.js';
import { coverageOverlay } from '../services/coverage.js';
import { ErrorResponse } from './camera-contracts.js';

const CoverageFeature = z.object({
  type: z.literal('Feature'),
  id: z.string(),
  geometry: z.object({ type: z.string(), coordinates: z.unknown() }).passthrough(),
  properties: z.object({
    id: z.string(),
    externalId: z.string(),
    /** `trusted` counts towards trusted coverage; `untrusted` is everything else that is drawn. */
    state: z.enum(['trusted', 'untrusted', 'uncovered']),
    /** The API's band verbatim, so a never-probed cell stays distinguishable from a bad one. */
    band: z.string(),
    rangeM: z.number(),
  }),
});

const CoverageOverlayResponse = z.object({
  type: z.literal('FeatureCollection'),
  features: z.array(CoverageFeature),
});

export function registerCoverageRoutes(app: App, deps: { db: Db }): void {
  const { db } = deps;

  app.get(
    '/api/v1/coverage/overlay',
    {
      onRequest: [authenticate(db)],
      preHandler: [requireRole(READ_ROLES)],
      schema: {
        tags: ['coverage'],
        summary: 'Camera coverage cells as GeoJSON, tagged trusted or untrusted',
        description:
          'Reads `camera_coverage`, which `npm run report:gap-analysis` populates. Cameras without ' +
          'coordinates have a row with null geometry and do not appear here — they are ' +
          'unassessable, not uncovered.',
        response: { 200: CoverageOverlayResponse, 401: ErrorResponse, 403: ErrorResponse },
      },
    },
    async () => coverageOverlay(db),
  );
}
