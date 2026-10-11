/**
 * Which cameras the answer could have come from (D4-21).
 *
 * A trace searches only the plate reads the analytics worker produced, and the worker analyses a
 * subset of the registry. Without this line an empty or short trace reads as "the vehicle was not
 * there", which can wrongly rule a location out of an investigation. The sentence comes from the
 * API (`coverage.cameraStatement`) so the screen, the CSV and the PDF say exactly the same thing.
 */
import type { TracePayload } from './types';

type Coverage = TracePayload['coverage'];
type CameraSet = Coverage['analysedCameras'];

export function CameraCoverage({ coverage }: { coverage: Coverage }) {
  return (
    <div
      className="mt-2 rounded border border-amber-900/50 bg-amber-950/20 px-2.5 py-1.5 text-xs text-amber-100"
      data-testid="trace-camera-coverage"
    >
      <p className="font-medium">{coverage.cameraStatement}</p>
      <p className="mt-0.5 text-amber-200/70">
        A camera counts as analysed when it has at least one sighting in this window: that is the
        only evidence of analysis the data holds.
      </p>
      <CameraList label="Analysed" set={coverage.analysedCameras} />
      <CameraList label="Not analysed" set={coverage.notAnalysedCameras} />
    </div>
  );
}

function CameraList({ label, set }: { label: string; set: CameraSet }) {
  if (set.count === 0) return null;
  const more = set.count - set.cameras.length;
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-amber-200/90">
        {label} · {set.count}
      </summary>
      <p className="mt-1 text-amber-200/70">
        {set.cameras.map((camera) => camera.externalId).join(', ')}
        {more > 0 ? ` … and ${String(more)} more` : ''}
      </p>
    </details>
  );
}
