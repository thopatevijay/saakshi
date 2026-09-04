/**
 * The first consumers of the generated types. D1-02 builds the registry API on top of these; this
 * file exists so the types are *used*, not merely exported — an unconsumed type proves nothing.
 */
import { asc, eq, sql } from 'drizzle-orm';
import { cameras, departments, users } from '@saakshi/shared/db';
import type { CameraRow, DepartmentRow, NewCamera, UserRow } from '@saakshi/shared';
import type { Db } from './client.js';

export async function listDepartments(db: Db): Promise<DepartmentRow[]> {
  return db.select().from(departments).orderBy(asc(departments.code));
}

export async function listUsersByRole(db: Db, role: UserRow['role']): Promise<UserRow[]> {
  return db.select().from(users).where(eq(users.role, role));
}

export async function getCameraByExternalId(
  db: Db,
  externalId: string,
): Promise<CameraRow | undefined> {
  const rows = await db.select().from(cameras).where(eq(cameras.externalId, externalId)).limit(1);
  return rows[0];
}

/**
 * Catalogue upsert. Keyed on `external_id` because ingest (D1-04) re-reads the whole catalogue on
 * every poll and must not duplicate cameras. Declared fields are overwritten — the department's
 * latest claim wins — while `trust_score` and `status` are left alone, since those are *measured*
 * and a re-import must never silently reset them.
 */
export async function upsertCamera(db: Db, camera: NewCamera): Promise<CameraRow> {
  const rows = await db
    .insert(cameras)
    .values(camera)
    .onConflictDoUpdate({
      target: cameras.externalId,
      set: {
        name: camera.name,
        adapterKind: camera.adapterKind,
        endpoints: camera.endpoints ?? {},
        declaredCodec: camera.declaredCodec ?? null,
        declaredFps: camera.declaredFps ?? null,
        declaredResolution: camera.declaredResolution ?? null,
        updatedAt: sql`now()`,
      },
    })
    .returning();

  const row = rows[0];
  if (row === undefined) throw new Error(`upsert of camera ${camera.externalId} returned no row`);
  return row;
}
