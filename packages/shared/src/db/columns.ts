import { customType } from 'drizzle-orm/pg-core';

/**
 * PostGIS `geography` columns.
 *
 * drizzle ships a `geometry` helper but not `geography`, and the difference matters here: every
 * distance and travel-time calculation in the system is over real distances on the ellipsoid
 * (camera spacing, impossible-transition speeds), which is what `geography` gives for free and
 * `geometry` does not.
 *
 * Values are read and written as WKT/EWKT text. PostGIS accepts WKT on insert and the driver is
 * configured to return geography as text, so `ST_AsText`/`ST_GeomFromText` stay explicit in queries
 * rather than hiding behind a codec.
 */
const geographyType = (subtype: 'Point' | 'Polygon' | 'LineString') =>
  customType<{ data: string; driverData: string }>({
    dataType: () => `geography(${subtype},4326)`,
  });

export const geographyPoint = geographyType('Point');
export const geographyPolygon = geographyType('Polygon');
export const geographyLineString = geographyType('LineString');

/**
 * `numeric` mapped to a JS number.
 *
 * drizzle returns `numeric` as a string by default, to preserve arbitrary precision. Every numeric
 * column in this schema is a bounded score, confidence or frame rate — a value where arithmetic is
 * the point and a double is exact enough — so the string form only invites `Number(x)` at every
 * call site.
 */
export const numericAsNumber = customType<{ data: number; driverData: string }>({
  dataType: () => 'numeric',
  fromDriver: (value) => Number(value),
  toDriver: (value) => String(value),
});
