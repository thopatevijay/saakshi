/**
 * The audit chain moved to `services/audit.ts` in D3-04, where verification, search and the export
 * manifest live alongside the write path they have to agree with.
 *
 * This file stays as the import path, because fifteen call sites across `routes/`, `jobs/` and
 * `services/` already write through it and churning them all would bury the one change that
 * matters — the digest and the fork-proof append — in an unreviewable diff.
 */
export * from './services/audit.js';
