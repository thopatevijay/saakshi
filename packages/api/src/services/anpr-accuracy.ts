/**
 * The measured ANPR accuracy, stated once for every artefact that prints it.
 *
 * D4-04's AC 6 requires the deck's accuracy figures to be **identical** to
 * `submission/govt-feed-output-report.pdf`, and D4-03's handoff says the same thing from the other
 * side: *"the measured accuracy in this report must match the number in the deck. Reconcile them
 * before submitting."*
 *
 * They did not, and the test caught it: the report rendered *"Human-legible plates in the
 * 120-instance sample: 3"* while the deck rendered *"3 of 120"*. The same fact in different words is
 * exactly the drift that survives a proofread and that a scorer notices, so the wording lives here
 * and both documents read it.
 *
 * ## Where these numbers come from
 *
 * D2-01 (#15), documented with its sampling method in `docs/anpr-accuracy.md` §2–3: **120 vehicle
 * instances hand-labelled from this estate**, day and night sampled separately. They are *not*
 * recomputed from whatever window a report happens to cover — four reads is not a sample precision
 * can honestly be derived from, and a second number that disagreed with the published one would be
 * worse than none.
 */
export const MEASURED_ANPR = {
  exactReadRecall: '0 of 3 — 0%',
  precision: '0%',
  plateDetectionRecall: '100% on n=3',
  characterAccuracy: '51.8%',
  legiblePlates: '3 of 120',
  /** The sentence both artefacts use when reporting against the challenge's stated target. */
  verdictAgainstTarget:
    'MISSES the challenge’s >90% detection/processing accuracy target, and is reported as missing',
} as const;

/** The accuracy block, as rendered in both the deck and the output report. */
export const MEASURED_ANPR_LINES: readonly string[] = [
  `Exact read recall (reads equal to the human label, over legible plates): ${MEASURED_ANPR.exactReadRecall}`,
  `Precision (correct reads over all reads emitted): ${MEASURED_ANPR.precision}`,
  `Plate-detection recall (plate boxes over human-legible plates): ${MEASURED_ANPR.plateDetectionRecall}`,
  `Character accuracy (1 - editDistance/len, over legible instances): ${MEASURED_ANPR.characterAccuracy}`,
  `Human-legible plates in the hand-labelled sample: ${MEASURED_ANPR.legiblePlates}`,
];
