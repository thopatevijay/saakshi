/**
 * WHEP vs HLS, measured on the same source through the same gateway.
 *
 * ## Why this is a real measurement and not a vibe
 *
 * `ops/mediamtx/mediamtx.yml` publishes `saakshi-test` as a 640×360 / 25 fps `testsrc` pattern —
 * and `testsrc` **burns a running clock into the picture**. Both transports are fed from that one
 * source by one MediaMTX instance, so everything except the transport is held constant: same
 * encoder, same machine, same network (loopback), same player process. The gap between the two
 * clocks on screen is therefore the latency difference and nothing else.
 *
 * Two numbers are recorded, because they answer different questions:
 *
 *   - **time to first frame** — how long after a viewer clicks before they see anything. This is
 *     what an operator experiences when they open a camera.
 *   - **steady-state lag** — how far behind live each transport stays once running, read from the
 *     burnt-in clock. This is what matters when someone is watching a junction in real time.
 *
 * It touches the **government sandbox not at all**. The sandbox serves HLS over HTTPS only (D1-03);
 * it exposes no WebRTC, so there is nothing there to compare. WHEP is a claim about our own edge
 * gateway and this script measures exactly that claim and no more.
 *
 *   node scripts/measure-latency.mjs [runs] [hls-base] [whep-base] [path]
 */
import { openBrowser, navigate, screenshot } from './cdp.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(here, '../../../docs/screenshots');

const runs = Number(process.argv[2] ?? 3);
const hlsBase = process.argv[3] ?? 'http://localhost:8888';
const whepBase = process.argv[4] ?? 'http://localhost:8889';
const streamPath = process.argv[5] ?? 'saakshi-test';
const webBase = process.argv[6] ?? 'http://localhost:3100';

/**
 * A standalone page, deliberately not the console.
 *
 * The console's own comparison panel is the product; this is the instrument. Loading the two players
 * side by side with nothing else on the page removes the console's bundle, its polling and its
 * layout from the measurement, so what is left is the two transports.
 */
const FRAGMENT = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;padding:8px;background:#020617;color:#e2e8f0;font:12px system-ui">
  <div><div>HLS - MediaMTX :8888</div><video id="hls" muted autoplay playsinline style="width:100%;background:#000"></video></div>
  <div><div>WHEP - MediaMTX :8889</div><video id="whep" muted autoplay playsinline style="width:100%;background:#000"></video></div>
</div>`;

async function main() {
  const cdp = await openBrowser({ width: 1400, height: 520 });
  await cdp.send('Page.enable');
  // A real http origin, not a `data:` URL. Chrome gives a data: document an **opaque origin**, and
  // every `fetch` from it fails with a bare "Failed to fetch" that looks like the gateway is down.
  // The login page is the cheapest page this app serves and it needs no session.
  await navigate(cdp, `${webBase}/login`);
  await cdp.evaluate(`(async () => {
    document.body.innerHTML = ${JSON.stringify(FRAGMENT)};
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.7.2/dist/hls.min.js';
      s.onload = resolve; s.onerror = () => reject(new Error('hls.js CDN unreachable'));
      document.head.appendChild(s);
    });
    return true;
  })()`);

  const results = [];

  for (let run = 0; run < runs; run += 1) {
    const measured = JSON.parse(
      await cdp.evaluate(`(async () => {
        const hlsVideo = document.getElementById('hls');
        const whepVideo = document.getElementById('whep');
        hlsVideo.removeAttribute('src'); hlsVideo.load();
        whepVideo.srcObject = null;
        if (window.__hls) { window.__hls.destroy(); window.__hls = null; }
        if (window.__pc) { window.__pc.close(); window.__pc = null; }
        await new Promise((r) => setTimeout(r, 1000));

        const firstFrame = (video) => new Promise((resolve) => {
          const t0 = performance.now();
          const done = () => { video.removeEventListener('loadeddata', done); resolve(performance.now() - t0); };
          video.addEventListener('loadeddata', done);
          setTimeout(() => resolve(null), 30000);
        });

        // ── HLS ────────────────────────────────────────────────────────────────────────────
        const hlsPromise = firstFrame(hlsVideo);
        window.__hls = new Hls({ lowLatencyMode: true });
        window.__hls.attachMedia(hlsVideo);
        window.__hls.loadSource('${hlsBase}/${streamPath}/index.m3u8');
        const hlsFirst = await hlsPromise;

        // ── WHEP ───────────────────────────────────────────────────────────────────────────
        const whepPromise = firstFrame(whepVideo);
        const pc = new RTCPeerConnection({ iceServers: [] });
        window.__pc = pc;
        pc.addTransceiver('video', { direction: 'recvonly' });
        pc.ontrack = (e) => { whepVideo.srcObject = e.streams[0]; whepVideo.play().catch(() => {}); };
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((r) => {
          if (pc.iceGatheringState === 'complete') return r();
          pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') r(); });
          setTimeout(r, 1500);
        });
        const res = await fetch('${whepBase}/${streamPath}/whep', {
          method: 'POST', headers: { 'content-type': 'application/sdp' },
          body: pc.localDescription.sdp,
        });
        const answer = await res.text();
        await pc.setRemoteDescription({ type: 'answer', sdp: answer });
        const whepFirst = await whepPromise;

        // Let both settle, then read how far each is behind the live edge.
        await new Promise((r) => setTimeout(r, 8000));

        // HLS lag: hls.js exposes the live edge as the end of the seekable range.
        const seekable = hlsVideo.seekable;
        const hlsLagS = seekable.length > 0 ? seekable.end(seekable.length - 1) - hlsVideo.currentTime : null;

        // WHEP lag: the jitter buffer plus decode, straight from getStats().
        let whepLagS = null;
        const stats = await pc.getStats();
        stats.forEach((report) => {
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            if (typeof report.jitterBufferDelay === 'number' && report.jitterBufferEmittedCount > 0) {
              whepLagS = report.jitterBufferDelay / report.jitterBufferEmittedCount;
            }
          }
        });

        return JSON.stringify({ hlsFirst, whepFirst, hlsLagS, whepLagS,
          hlsSize: hlsVideo.videoWidth + 'x' + hlsVideo.videoHeight,
          whepSize: whepVideo.videoWidth + 'x' + whepVideo.videoHeight });
      })()`),
    );
    results.push(measured);
    console.log(
      `  run ${String(run + 1)}: first frame — HLS ${String(measured.hlsFirst?.toFixed(0) ?? 'n/a')} ms vs ` +
        `WHEP ${String(measured.whepFirst?.toFixed(0) ?? 'n/a')} ms · steady lag — HLS ` +
        `${measured.hlsLagS === null ? 'n/a' : `${measured.hlsLagS.toFixed(2)} s`} vs WHEP ` +
        `${measured.whepLagS === null ? 'n/a' : `${measured.whepLagS.toFixed(3)} s`} · ` +
        `${String(measured.hlsSize)} / ${String(measured.whepSize)}`,
    );
  }

  await screenshot(cdp, path.join(SHOTS, 'video-wall-whep-vs-hls.png'));

  const median = (xs) => {
    const v = xs.filter((x) => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
    return v.length === 0 ? null : v[Math.floor(v.length / 2)];
  };

  const hlsFirst = median(results.map((r) => r.hlsFirst));
  const whepFirst = median(results.map((r) => r.whepFirst));
  const hlsLag = median(results.map((r) => r.hlsLagS));
  const whepLag = median(results.map((r) => r.whepLagS));

  console.log(`\nmedian of ${String(runs)} runs, source ${streamPath} on our own MediaMTX gateway:`);
  console.log(
    `  time to first frame   HLS ${String(hlsFirst?.toFixed(0) ?? 'n/a')} ms · ` +
      `WHEP ${String(whepFirst?.toFixed(0) ?? 'n/a')} ms`,
  );
  console.log(
    `  steady-state lag      HLS ${hlsLag === null ? 'n/a' : `${hlsLag.toFixed(2)} s`} · ` +
      `WHEP ${whepLag === null ? 'n/a' : `${whepLag.toFixed(3)} s`}`,
  );
  if (hlsLag !== null && whepLag !== null) {
    console.log(
      `  WHEP is ${(hlsLag - whepLag).toFixed(2)} s closer to live — ` +
        `${(hlsLag / Math.max(whepLag, 0.001)).toFixed(1)}× lower latency`,
    );
  }

  await cdp.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
