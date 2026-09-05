/**
 * Plate normalisation and Indian registration grammar (D2-03).
 *
 * Pure, deterministic, zero I/O. Shared so the Python worker's output, the API's watchlist lookup
 * and D2-04's fuzzy index all agree on one canonical form — `[A-Z0-9]`, separators stripped.
 */
export * from './normalise.js';
export * from './grammar.js';
