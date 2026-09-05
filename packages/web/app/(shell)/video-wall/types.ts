import type { paths } from '@/src/lib/api/schema';

export type StreamManifest =
  paths['/api/v1/streams/{id}/manifest']['get']['responses'][200]['content']['application/json'];

export type StreamDetections =
  paths['/api/v1/streams/{id}/detections']['get']['responses'][200]['content']['application/json'];

export type RelayStats =
  paths['/api/v1/streams/relay/stats']['get']['responses'][200]['content']['application/json'];

/** The camera list the picker and the default wall are built from. */
export interface WallCamera {
  id: string;
  externalId: string;
  name: string;
  departmentCode: string | null;
  district: string | null;
  band: 'trusted' | 'degraded' | 'untrusted' | 'dead' | null;
  trustScore: number | null;
}
