import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from '../db/client.js';
import type { PlateMatcher } from './matcher.js';
import { MockProvider } from './mock-provider.js';
import {
  WatchlistSystem,
  type LookupOptions,
  type ProviderHealth,
  type SyncResult,
  type WatchlistHit,
  type WatchlistProvider,
} from './provider.js';

export * from './provider.js';
export * from './matcher.js';
export { MockProvider } from './mock-provider.js';
export * from './seed.js';

/** The committed representative dataset — the mock providers' upstream. */
export const SEED_CSV_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../fixtures/watchlist-seed.csv',
);

/**
 * Every registered connector, and the fan-out across them.
 *
 * **The point of this class is that adding a provider changes nothing else.** A connector is a
 * `WatchlistProvider`; `register` takes one; lookups fan out to all of them. Neither the routes,
 * the mock provider, the matcher nor this file needs an edit to accept a sixth, a seventh, or a
 * real one replacing a mock. The `null`-provider test proves it by defining a whole provider inside
 * the test file and registering it — if any part of the core had to know about it, that test could
 * not be written.
 *
 * Keyed by `system`, so registering a real eGujCop connector *replaces* the eGujCop mock and leaves
 * the other five answering. That is the cutover shape a department would actually ask for: one
 * system at a time, with the rest still serving.
 */
export class WatchlistRegistry {
  private readonly providers = new Map<WatchlistSystem, WatchlistProvider>();

  register(provider: WatchlistProvider): this {
    this.providers.set(provider.system, provider);
    return this;
  }

  get(system: WatchlistSystem): WatchlistProvider | undefined {
    return this.providers.get(system);
  }

  list(): WatchlistProvider[] {
    return [...this.providers.values()];
  }

  /**
   * All hits across all providers, best match first.
   *
   * Ties broken by severity, because two providers returning the same distance is a real case — the
   * same plate can be on a VAHAN stolen record and an eGujCop FIR — and the control room needs the
   * more serious one at the top rather than whichever provider was registered first.
   */
  async lookupVehicle(plate: string, options?: LookupOptions): Promise<WatchlistHit[]> {
    const batches = await Promise.all(this.list().map((p) => p.lookupVehicle(plate, options)));
    return rank(batches.flat(), options?.limit);
  }

  async lookupPerson(ref: string, options?: LookupOptions): Promise<WatchlistHit[]> {
    const batches = await Promise.all(this.list().map((p) => p.lookupPerson(ref, options)));
    return rank(batches.flat(), options?.limit);
  }

  async syncAll(since?: Date): Promise<SyncResult[]> {
    const results: SyncResult[] = [];
    // Sequential rather than parallel: they upsert into one table on one natural key, and six
    // concurrent `ON CONFLICT` batches against the same index deadlock for no gain at this size.
    for (const provider of this.list()) results.push(await provider.sync(since));
    return results;
  }

  async health(): Promise<ProviderHealth[]> {
    return Promise.all(this.list().map((p) => p.health()));
  }
}

const SEVERITY_RANK: Record<WatchlistHit['severity'], number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

function rank(hits: WatchlistHit[], limit?: number): WatchlistHit[] {
  const sorted = [...hits].sort(
    (a, b) =>
      a.matchDistance - b.matchDistance ||
      SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
      b.matchConfidence - a.matchConfidence,
  );
  return limit === undefined ? sorted : sorted.slice(0, limit);
}

export interface RegistryOptions {
  db: Db;
  /** D2-04 passes its confusion-aware matcher here; every mock provider then uses it. */
  matcher?: PlateMatcher;
  seedPath?: string;
}

/**
 * The default estate: one `MockProvider` per specified system.
 *
 * All six are mocks. **None of them is live, and none of them will be until a department provides
 * the access `docs/watchlist-integration.md` enumerates.**
 */
export function createWatchlistRegistry(options: RegistryOptions): WatchlistRegistry {
  const registry = new WatchlistRegistry();
  for (const system of WatchlistSystem.options) {
    registry.register(
      new MockProvider({
        db: options.db,
        system,
        seedPath: options.seedPath ?? SEED_CSV_PATH,
        ...(options.matcher !== undefined ? { matcher: options.matcher } : {}),
      }),
    );
  }
  return registry;
}
