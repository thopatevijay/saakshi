import { Suspense } from 'react';
import { EmptyState } from '@/src/components/states';
import { defaultLayout, normaliseLayout } from '@/src/lib/wall/layout';
import { loadLayout, loadWallCameras } from './actions';
import { WallScreen } from './wall-screen';

export const dynamic = 'force-dynamic';

/**
 * The video wall's server half.
 *
 * Two fetches, both server-side through the generated client: the estate (for the picker and the
 * default wall) and this operator's saved layout. Doing them here rather than in a `useEffect`
 * keeps the first paint honest — a client-side first fetch would put a round trip after hydration
 * and the screen would appear instantly with nothing on it.
 *
 * **No stream is opened here.** The page renders tile shells; each tile decides for itself whether
 * to open a connection, and only when it is actually on screen. That is the organisers' pacing
 * request and two of this ticket's acceptance criteria, and putting the decision anywhere but the
 * tile would break both.
 *
 * The gateway self-test path is read from the environment rather than hardcoded, for the same
 * reason every other endpoint in this repo is: a deployment's MediaMTX is not on `localhost`.
 */
export default async function VideoWallPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const requested = params['camera'];
  const initialCameraId = typeof requested === 'string' ? requested : null;

  const [cameras, stored] = await Promise.all([loadWallCameras(), loadLayout()]);

  if (cameras.length === 0) {
    return (
      <div className="space-y-6">
        <h1 className="text-xl font-semibold text-slate-100">Video wall</h1>
        <EmptyState
          title="No cameras onboarded yet"
          description="The wall shows cameras from the registry. Run the catalogue sync or onboard a camera, and it will appear here."
        />
      </div>
    );
  }

  const known = new Set(cameras.map((camera) => camera.id));
  const layout =
    stored === null
      ? defaultLayout(cameras.map((camera) => camera.id))
      : normaliseLayout(stored, known);

  const whepBase = process.env['MEDIAMTX_WHEP_BASE'] ?? 'http://localhost:8889';
  const hlsBase = process.env['MEDIAMTX_HLS_BASE'] ?? 'http://localhost:8888';
  const selfTestPath = process.env['MEDIAMTX_SELFTEST_PATH'] ?? 'saakshi-test';

  return (
    // `useSearchParams` in the screen needs a suspense boundary for the static shell.
    <Suspense fallback={null}>
      <WallScreen
        cameras={cameras}
        initialLayout={layout}
        initialCameraId={initialCameraId}
        selfTest={{
          path: selfTestPath,
          hlsUrl: `${hlsBase}/${selfTestPath}/index.m3u8`,
          whepUrl: `${whepBase}/${selfTestPath}/whep`,
        }}
      />
    </Suspense>
  );
}
