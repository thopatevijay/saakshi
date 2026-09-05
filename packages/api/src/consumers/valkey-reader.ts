/**
 * The real `SightingStreamReader`, over ioredis.
 *
 * Kept apart from `sightings.ts` so the consumer's decode → resolve → insert logic can be tested
 * without a broker, while the broker-specific parts — `BUSYGROUP` on an existing group, ioredis'
 * nested reply shape — live in one small file that the live gate run exercises for real.
 *
 * `valkey` speaks the redis wire protocol, which is why a redis client is the right dependency.
 */
import { Redis } from 'ioredis';
import type { SightingStreamReader, StreamEntry } from './sightings.js';
import type { BusInspector } from '../metrics.js';

/** ioredis returns `[ [stream, [ [id, [field, value, …] ], … ] ], … ]` — or null on a block timeout. */
type XReadGroupReply = [string, [string, string[]][]][] | null;

export function createValkeyReader(url: string): SightingStreamReader {
  const client = new Redis(url, { maxRetriesPerRequest: null });

  return {
    async ensureGroup(stream, group) {
      try {
        await client.xgroup('CREATE', stream, group, '0', 'MKSTREAM');
      } catch (error) {
        // BUSYGROUP means it already exists, which is the normal case on every restart after the
        // first. Anything else is a real failure and must not be swallowed.
        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('BUSYGROUP')) throw error;
      }
    },

    async read({ stream, group, consumer, count, blockMs }) {
      const reply = (await client.xreadgroup(
        'GROUP',
        group,
        consumer,
        'COUNT',
        count,
        'BLOCK',
        blockMs,
        'STREAMS',
        stream,
        '>',
      )) as XReadGroupReply;

      if (reply === null) return [];
      const entries: StreamEntry[] = [];
      for (const [, items] of reply) {
        for (const [id, fields] of items) {
          const index = fields.indexOf('payload');
          if (index === -1 || index + 1 >= fields.length) continue;
          entries.push({ id, payload: fields[index + 1] ?? '' });
        }
      }
      return entries;
    },

    async ack(stream, group, ids) {
      if (ids.length === 0) return;
      await client.xack(stream, group, ...ids);
    },

    async close() {
      await client.quit();
    },
  };
}

/**
 * Read-only stream introspection for the bus-lag gauges (D3-10).
 *
 * Separate from the reader because it must *never* create a group or consume an entry: a monitoring
 * client that joined `sightings-writer` would silently steal entries from the real consumer. It
 * calls `XINFO` only.
 *
 * `enableOfflineQueue: false` so a scrape against a down Valkey fails immediately instead of
 * queueing commands until the scrape times out — the metrics endpoint must answer even when a
 * dependency is unreachable, because "unreachable" is exactly what it is there to report.
 */
export interface BusInspectorHandle extends BusInspector {
  close(): Promise<void>;
}

/** ioredis returns XINFO replies as a flat `[field, value, field, value, …]` array. */
function fieldsOf(reply: unknown): Map<string, unknown> {
  const out = new Map<string, unknown>();
  if (!Array.isArray(reply)) return out;
  for (let i = 0; i + 1 < reply.length; i += 2) {
    out.set(String(reply[i]), reply[i + 1]);
  }
  return out;
}

function toNumber(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** `ERR no such key` — a stream nobody has published to yet. Zero entries, not an error. */
function isMissingStream(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes('no such key');
}

export function createValkeyInspector(url: string): BusInspectorHandle {
  const client = new Redis(url, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  // A metrics client must never crash the process it is measuring.
  client.on('error', () => {});

  return {
    async streamLength(stream) {
      try {
        return toNumber(fieldsOf(await client.xinfo('STREAM', stream)).get('length'));
      } catch (error) {
        if (isMissingStream(error)) return 0;
        throw error;
      }
    },

    async groups(stream) {
      let reply: unknown;
      try {
        reply = await client.xinfo('GROUPS', stream);
      } catch (error) {
        if (isMissingStream(error)) return [];
        throw error;
      }
      if (!Array.isArray(reply)) return [];
      return reply.map((entry) => {
        const fields = fieldsOf(entry);
        return {
          name: String(fields.get('name') ?? 'unknown'),
          pending: toNumber(fields.get('pending')),
          // `lag` is null when Valkey cannot compute it (entries trimmed away beneath the group's
          // cursor). Reported as 0 rather than invented, and the pending gauge still tells the
          // "stuck consumer" half of the story.
          lag: toNumber(fields.get('lag')),
          consumers: toNumber(fields.get('consumers')),
        };
      });
    },

    async close() {
      await client.quit();
    },
  };
}
