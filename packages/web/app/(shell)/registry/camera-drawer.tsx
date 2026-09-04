'use client';

/**
 * The camera detail drawer.
 *
 * ## "The full trust breakdown, not just the score"
 *
 * That acceptance criterion is the product. The score's entire credibility rests on a judge — or an
 * officer about to rely on a clip in court — clicking a camera and seeing **exactly which signal
 * cost it points**. So this renders every row the API returns: each signal with its raw
 * measurement, its weight, its points out of its maximum and the note explaining the judgement;
 * every *excluded* signal with the reason it was excluded; the weights version; and the points
 * total, which the API returns rather than leaving the client to compute so that "the breakdown
 * sums to the score" is a claim the server can be held to.
 *
 * **The exclusions are as important as the signals.** D1-06's rule is that a signal which cannot be
 * judged is dropped from the denominator, never scored zero — every sandbox row is VOD, so the
 * clock signal is inapplicable for all thirty cameras, and scoring it zero would quietly cost each
 * of them ten points for our own gateway being a file server. A breakdown that showed only what
 * counted would hide the most interesting half.
 *
 * ## Three independent facts, three badges
 *
 * Trust band (measured quality) · catalogue presence (is it still listed upstream) · health status
 * (what the prober last wrote). D1-04's handoff forbids merging presence and health into one badge,
 * and the band is a third thing again. A camera can be listed and dead, or delisted and serving.
 */
import { useEffect } from 'react';
import {
  BAND_STYLE,
  CATALOGUE_STATUS_CHIP,
  HEALTH_STATUS_CHIP,
  bandKeyOf,
} from '@/src/lib/registry/trust';
import { Spinner } from '@/src/components/states';
import type { CameraDetailPayload } from './registry-screen';

const CHIP = 'inline-block rounded border px-2 py-0.5 text-[11px] font-medium';

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[10px] uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 truncate text-xs text-slate-200">{value}</dd>
    </div>
  );
}

const show = (value: string | number | null | undefined): string =>
  value === null || value === undefined || value === '' ? '—' : String(value);

export function CameraDrawer({
  detail,
  loading,
  onClose,
}: {
  detail: CameraDetailPayload | null;
  loading: boolean;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const camera = detail?.camera ?? null;
  const trust = detail?.trust ?? null;
  const band = BAND_STYLE[bandKeyOf(camera?.band ?? null)];
  const health = camera?.latestHealth ?? null;
  const delta = camera?.declaredVsMeasured ?? null;

  return (
    <aside
      role="dialog"
      aria-modal="false"
      aria-label="Camera detail"
      data-testid="camera-drawer"
      className="fixed right-0 top-0 z-40 flex h-dvh w-[26rem] max-w-[92vw] flex-col border-l border-slate-800 bg-slate-950/98 shadow-2xl backdrop-blur"
    >
      <header className="flex items-start justify-between gap-3 border-b border-slate-800 px-5 py-4">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-slate-100">
            {camera?.externalId ?? 'Loading'}
          </h2>
          <p className="truncate text-xs text-slate-400">{camera?.name ?? ''}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close camera detail"
          className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-300 hover:bg-slate-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-sky-400"
        >
          Close
        </button>
      </header>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-5 py-4">
        {loading && camera === null ? <Spinner label="Loading camera" /> : null}

        {camera === null ? null : (
          <>
            {/* ── Three independent facts ─────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <div className="flex flex-wrap items-center gap-2">
                <span
                  className={`${CHIP} ${band.chip}`}
                  data-drawer-band={bandKeyOf(camera.band)}
                  title={band.meaning}
                >
                  Trust · {band.label}
                  {camera.trustScore === null ? '' : ` · ${camera.trustScore.toFixed(2)}`}
                </span>
                <span
                  className={`${CHIP} ${CATALOGUE_STATUS_CHIP[camera.catalogueStatus] ?? ''}`}
                  title="Presence in the upstream catalogue. Nothing to do with whether the camera works."
                >
                  Catalogue · {camera.catalogueStatus}
                </span>
                <span
                  className={`${CHIP} ${HEALTH_STATUS_CHIP[camera.status] ?? ''}`}
                  title="Measured health, written by the prober. Independent of catalogue presence."
                >
                  Health · {camera.status}
                </span>
              </div>
              <p className="text-[11px] leading-relaxed text-slate-500">
                Three separate facts. Presence is whether the department still lists it; health is
                what the prober last wrote; the band is what the measurements say. A camera can be
                listed and dead, or delisted and still serving.
                {camera.status === 'unknown' ? (
                  <>
                    {' '}
                    <span className="text-slate-400">
                      Health reads `unknown` because no job writes that column yet — the measured
                      picture is the band and the health check below.
                    </span>
                  </>
                ) : null}
              </p>
            </section>

            {/* ── Metadata ────────────────────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Registry
              </h3>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                <Field label="Department" value={show(camera.departmentCode)} />
                <Field label="District" value={show(camera.district)} />
                <Field
                  label="Location"
                  value={
                    camera.lat === null || camera.lon === null ? (
                      <span className="text-amber-400">no coordinates</span>
                    ) : (
                      `${camera.lat.toFixed(5)}, ${camera.lon.toFixed(5)}`
                    )
                  }
                />
                <Field label="Address" value={show(camera.address)} />
                <Field label="Type" value={camera.cameraType} />
                <Field label="Mount" value={camera.mount} />
                <Field label="Geometry" value={camera.geometryClass.replaceAll('_', ' ')} />
                <Field label="Adapter" value={camera.adapterKind} />
                <Field label="Vendor" value={show(camera.vendor)} />
                <Field label="VMS" value={show(camera.vmsPlatform)} />
                <Field
                  label="Retention"
                  value={camera.retentionDays === null ? '—' : `${String(camera.retentionDays)} days`}
                />
                <Field label="Storage" value={show(camera.storageType)} />
              </dl>

              <div>
                <h4 className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">Endpoints</h4>
                {Object.keys(camera.endpoints).length === 0 ? (
                  <p className="text-xs text-slate-500">None recorded.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {Object.entries(camera.endpoints).map(([key, value]) => (
                      <li key={key} className="truncate text-[11px] text-slate-400">
                        <span className="text-slate-500">{key}</span>{' '}
                        <code className="text-slate-300">{value}</code>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <button
                type="button"
                disabled
                title="Live preview lands with the video wall (D3-07). Disabled rather than hidden, so the path is visible."
                className="mt-1 w-full cursor-not-allowed rounded-md border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-500"
              >
                Live preview · wired in D3-07
              </button>
            </section>

            {/* ── Declared vs measured ────────────────────────────────────────────────────── */}
            {delta === null ? null : (
              <section className="space-y-2">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Declared vs measured
                </h3>
                <p className="text-[11px] leading-relaxed text-slate-500">
                  Computed, never stored. A department that declared 25 fps on a camera measuring 10
                  is the gap this registry exists to surface — the delta is the product, not an
                  error.
                </p>
                <table className="w-full text-left text-[11px]">
                  <thead className="text-slate-500">
                    <tr>
                      <th scope="col" className="py-1 font-medium">
                        Attribute
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Declared
                      </th>
                      <th scope="col" className="py-1 font-medium">
                        Measured
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-800/70 text-slate-300">
                    <tr>
                      <td className="py-1.5">Frame rate</td>
                      <td className="py-1.5 tabular-nums">{show(delta.fpsDeclared)}</td>
                      <td className="py-1.5 tabular-nums">
                        {show(delta.fpsMeasured)}
                        {delta.fpsDelta === null ? null : (
                          <span
                            className={
                              Math.abs(delta.fpsDelta) < 1 ? 'ml-1 text-slate-500' : 'ml-1 text-amber-400'
                            }
                          >
                            ({delta.fpsDelta > 0 ? '+' : ''}
                            {delta.fpsDelta.toFixed(2)})
                          </span>
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1.5">Resolution</td>
                      <td className="py-1.5">{show(delta.resolutionDeclared)}</td>
                      <td
                        className={`py-1.5 ${delta.resolutionMatches === false ? 'text-amber-400' : ''}`}
                      >
                        {show(delta.resolutionMeasured)}
                      </td>
                    </tr>
                    <tr>
                      <td className="py-1.5">Codec</td>
                      <td className="py-1.5">{show(delta.codecDeclared)}</td>
                      <td className={`py-1.5 ${delta.codecMatches === false ? 'text-amber-400' : ''}`}>
                        {show(delta.codecMeasured)}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </section>
            )}

            {/* ── Latest health ───────────────────────────────────────────────────────────── */}
            <section className="space-y-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Latest health check
              </h3>
              {health === null ? (
                <p className="text-xs text-slate-500">
                  Never probed. That is an absence of evidence, not a bad result — the pin is drawn
                  as a hollow ring for exactly this reason.
                </p>
              ) : (
                <dl className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  <Field label="Checked at" value={new Date(health.checkedAt).toLocaleString()} />
                  <Field label="Connectable" value={health.connectable ? 'yes' : 'no'} />
                  <Field label="Decodable" value={health.decodable ? 'yes' : 'no'} />
                  <Field
                    label="Measured fps"
                    value={health.measuredFps === null ? 'could not measure' : health.measuredFps.toFixed(2)}
                  />
                  <Field label="Resolution" value={show(health.actualResolution)} />
                  <Field label="Codec" value={show(health.actualCodec)} />
                  <Field
                    label="Night usable"
                    value={health.nightUsable === null ? 'not assessed' : health.nightUsable ? 'yes' : 'no'}
                  />
                  <Field
                    label="PTS drift"
                    value={health.ptsDriftMs === null ? '—' : `${health.ptsDriftMs.toFixed(0)} ms`}
                  />
                </dl>
              )}
            </section>

            {/* ── The breakdown ───────────────────────────────────────────────────────────── */}
            <section className="space-y-2" data-testid="trust-breakdown">
              <div className="flex items-baseline justify-between">
                <h3 className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Trust breakdown
                </h3>
                {trust === null ? null : (
                  <span className="text-[10px] text-slate-500">
                    weights v{show(trust.breakdown.weightsVersion)}
                  </span>
                )}
              </div>

              {trust === null || trust.breakdown.signals.length === 0 ? (
                <p className="text-xs text-slate-500">
                  No breakdown: this camera has never been scored. Run a probe and a trust recompute
                  to produce one.
                </p>
              ) : (
                <>
                  <table className="w-full text-left text-[11px]">
                    <caption className="sr-only">
                      Every signal that contributed to this camera&rsquo;s trust score
                    </caption>
                    <thead className="text-slate-500">
                      <tr>
                        <th scope="col" className="py-1 font-medium">
                          Signal
                        </th>
                        <th scope="col" className="py-1 font-medium">
                          Raw
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          Weight
                        </th>
                        <th scope="col" className="py-1 text-right font-medium">
                          Points
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/70">
                      {trust.breakdown.signals.map((signal) => (
                        <tr key={signal.signal} data-signal={signal.signal} className="align-top">
                          <td className="py-1.5">
                            <span className="block text-slate-200">{signal.signal}</span>
                            <span className="block leading-snug text-slate-500">{signal.note}</span>
                          </td>
                          <td className="py-1.5 tabular-nums text-slate-300">
                            {signal.raw === null
                              ? '—'
                              : typeof signal.raw === 'boolean'
                                ? signal.raw
                                  ? 'yes'
                                  : 'no'
                                : signal.raw.toFixed(3)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-slate-400">
                            {signal.weight.toFixed(2)}
                          </td>
                          <td className="py-1.5 text-right tabular-nums text-slate-200">
                            {signal.points.toFixed(2)}
                            <span className="text-slate-500">/{signal.maxPoints.toFixed(2)}</span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="border-t border-slate-700">
                        <td colSpan={3} className="py-1.5 text-slate-400">
                          Points total
                        </td>
                        <td className="py-1.5 text-right tabular-nums font-medium text-slate-100">
                          {trust.breakdown.pointsTotal.toFixed(2)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>

                  {trust.breakdown.excluded.length === 0 ? null : (
                    <div className="rounded-md border border-slate-800 bg-slate-900/50 px-3 py-2">
                      <h4 className="text-[10px] uppercase tracking-wide text-slate-500">
                        Excluded from the denominator
                      </h4>
                      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                        A signal that cannot be judged is removed from the total, never scored zero.
                        Unmeasurable is not bad — scoring it as bad would condemn a camera for the
                        network&rsquo;s behaviour, or for our gateway serving a recording.
                      </p>
                      <ul className="mt-1.5 space-y-1">
                        {trust.breakdown.excluded.map((item) => (
                          <li key={item.signal} data-excluded={item.signal} className="text-[11px]">
                            <span className="text-slate-300">{item.signal}</span>
                            <span className="text-slate-500"> — {item.reason}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {trust.trend.length === 0 ? null : (
                    <div>
                      <h4 className="mt-2 text-[10px] uppercase tracking-wide text-slate-500">
                        Trend · last 7 days
                      </h4>
                      <ul className="mt-1 space-y-0.5">
                        {trust.trend.map((point) => (
                          <li key={point.bucket} className="flex justify-between text-[11px]">
                            <span className="text-slate-500">{point.bucket.slice(0, 10)}</span>
                            <span className="tabular-nums text-slate-300">
                              {point.score === null ? '—' : point.score.toFixed(2)}
                              <span className="ml-2 text-slate-500">
                                {point.reachableChecks}/{point.checks} reachable
                              </span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </>
              )}
            </section>
          </>
        )}
      </div>
    </aside>
  );
}
