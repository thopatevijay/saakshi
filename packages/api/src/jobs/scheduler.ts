/**
 * Scheduled catalogue sync (D1-04: "scheduled + on-demand").
 *
 * A plain interval rather than a cron library. The job is idempotent by construction — a re-sync
 * that changes nothing performs no content writes — so the only thing a schedule needs to get right
 * is not overlapping with itself, which a fixed interval plus an in-flight guard does.
 *
 * Off by default. A background job that reaches an external host on a timer is something a deploy
 * opts into, not something a fresh clone starts doing on its own.
 */
import type { Db } from '../db/client.js';
import type { FastifyBaseLogger } from 'fastify';
import { syncCatalogue } from './catalogue-sync.js';

export interface SchedulerOptions {
  db: Db;
  source: string;
  cookie?: string;
  intervalMinutes: number;
  log: FastifyBaseLogger;
}

export interface ScheduledSync {
  stop: () => void;
}

export function startCatalogueSchedule(options: SchedulerOptions): ScheduledSync | null {
  if (options.intervalMinutes <= 0) return null;

  let inFlight = false;

  const tick = async (): Promise<void> => {
    // The sandbox gateway throttles ~10× under sustained use (D1-03). Overlapping syncs would make
    // that worse and give two runs a claim on the same absence set.
    if (inFlight) {
      options.log.warn('catalogue sync still running, skipping this tick');
      return;
    }
    inFlight = true;
    try {
      const report = await syncCatalogue(options.db, {
        source: options.source,
        trigger: 'schedule',
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      });
      options.log.info(
        {
          runId: report.runId,
          added: report.added,
          updated: report.updated,
          unchanged: report.unchanged,
          wentAbsent: report.wentAbsent,
          returned: report.returned,
        },
        'catalogue sync complete',
      );
    } catch (err) {
      // Never fatal. An upstream that is down or has changed shape must not take the API with it;
      // the failed run is persisted and readable at GET /api/v1/sync/reports.
      options.log.error({ err }, 'scheduled catalogue sync failed');
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), options.intervalMinutes * 60_000);
  // Do not hold the process open for a background refresh.
  timer.unref();

  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
