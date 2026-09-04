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
