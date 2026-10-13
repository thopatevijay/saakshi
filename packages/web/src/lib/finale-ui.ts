/**
 * Stage-build switch for the 12–13 Oct 2026 finale (D4-23).
 *
 * Each flag hides one element from the screen. Hidden, not deleted: the components, the API fields
 * and the tests all stay. To restore all five after the finale, set `HIDE_FOR_FINALE` to `false`;
 * to restore one, set its own flag to `false`.
 */
const HIDE_FOR_FINALE: boolean = true;

export const FINALE_HIDE = {
  /** Shell top bar: "Search cameras — cam01, Paldi, Ahmedabad". */
  cameraSearch: HIDE_FOR_FINALE,
  /** Single-camera view: the "No WHEP path for this camera" card. */
  noWhepPath: HIDE_FOR_FINALE,
  /** Trace: the "Ask in plain English" panel (question box + Compile filter). */
  traceQueryConsole: HIDE_FOR_FINALE,
  /** Trace: "Searched the plate reads of N cameras…" with its Analysed / Not analysed lists. */
  traceCameraCoverage: HIDE_FOR_FINALE,
  /** Audit "Chain verifies" banner: the Pre-canonical and Forks counts. */
  auditChainExtraCounts: HIDE_FOR_FINALE,
} as const;
