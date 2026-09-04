import {
  UnreachableError,
  type AdapterCameraConfig,
  type CameraAdapter,
  type CameraCapabilities,
  type HealthSample,
  type StreamHandle,
} from './types.js';

/**
 * WHEP adapter — **demonstrated, not operational**.
 *
 * WHEP (WebRTC-HTTP Egress Protocol) is the low-latency browser path: sub-second glass-to-glass,
 * where HLS is 6–30 s behind. For a control room deciding whether to stop a vehicle, that
 * difference is the whole product — which is why the video wall (D3-07) uses HLS for the grid and
 * WHEP for the single camera an operator has actually focused on.
 *
 * **What this adapter does, precisely:** the HTTP signalling half — POST an SDP offer to the WHEP
 * endpoint, receive `201 Created` with an SDP answer and a `Location` for teardown, and validate
 * the answer. The media then flows **peer-to-peer to the browser**, which is what WHEP is for; a
 * WebRTC stack inside Node would put the server in a path it is not supposed to be in, and no AC
 * asks for it. So `open()` returns a handle with `stdout: null` and the negotiated session, and the
 * browser client in D3-07 consumes the media.
 *
 * The sandbox exposes no WHEP (`:8889` is absent, whatever the Integrator's Guide says). Verified
 * against local MediaMTX's real WHEP endpoint.
 */

export interface WhepAdapterOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface WhepSession {
  /** SDP answer from the server, handed to the browser's `RTCPeerConnection`. */
  answerSdp: string;
  /** Absolute URL for DELETE-based teardown, per the WHEP spec. */
  resourceUrl: string | null;
}

/**
 * A minimal, valid recvonly SDP offer.
 *
 * Hand-built rather than produced by a WebRTC library because the server only needs a
 * syntactically valid offer to answer with its own media description — and pulling in a full ICE
 * stack to negotiate a session the server never sends media over would be dead weight. The browser
 * generates the real offer in D3-07; this one is for signalling verification and health checks.
 */
export function buildRecvOnlyOffer(): string {
  return [
    'v=0',
    'o=- 0 0 IN IP4 127.0.0.1',
    's=saakshi-whep-probe',
    't=0 0',
    'a=group:BUNDLE 0',
    'm=video 9 UDP/TLS/RTP/SAVPF 96',
    'c=IN IP4 0.0.0.0',
    'a=rtcp-mux',
    'a=ice-ufrag:saakshi',
    'a=ice-pwd:saakshiwheppasswordvalue',
    'a=fingerprint:sha-256 ' +
      '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF:' +
      '00:11:22:33:44:55:66:77:88:99:AA:BB:CC:DD:EE:FF',
    'a=setup:actpass',
    'a=mid:0',
    'a=recvonly',
    'a=rtpmap:96 H264/90000',
    '',
  ].join('\r\n');
}

/**
 * WHEP exposes `negotiate()` beyond the shared interface: the signalling result (the SDP answer and
 * the teardown URL) is what D3-07's browser client needs handed to it, and no other transport has
 * an offer/answer step.
 */
export interface WhepAdapter extends CameraAdapter {
  negotiate(cfg: AdapterCameraConfig): Promise<WhepSession>;
}

export function createWhepAdapter(options: WhepAdapterOptions = {}): WhepAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 10_000;

  const urlFor = (cfg: AdapterCameraConfig): string => {
    const url = cfg.endpoints['whep'] ?? cfg.endpoints['url'];
    if (url === undefined || url === '') {
      throw new UnreachableError(
        `camera ${cfg.externalId} has no 'whep' endpoint in its registry row`,
        cfg.externalId,
        'whep',
      );
    }
    return url;
  };

  /** The WHEP handshake: offer in, answer out. */
  async function negotiate(cfg: AdapterCameraConfig): Promise<WhepSession> {
    const url = urlFor(cfg);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/sdp' },
        body: buildRecvOnlyOffer(),
        signal: controller.signal,
      });

      // The spec says 201 Created. Anything else means no session exists.
      if (response.status !== 201) {
        throw new UnreachableError(
          `WHEP endpoint for ${cfg.externalId} answered HTTP ${String(response.status)} ` +
            `(expected 201 Created)`,
          cfg.externalId,
          'whep',
        );
      }

      const answerSdp = await response.text();
      if (!answerSdp.startsWith('v=0')) {
        throw new UnreachableError(
          `WHEP endpoint for ${cfg.externalId} returned a body that is not SDP`,
          cfg.externalId,
          'whep',
        );
      }

      const location = response.headers.get('location');
      return {
        answerSdp,
        resourceUrl: location === null ? null : new URL(location, url).toString(),
      };
    } catch (error) {
      if (error instanceof UnreachableError) throw error;
      throw new UnreachableError(
        `WHEP endpoint for ${cfg.externalId} is not reachable`,
        cfg.externalId,
        'whep',
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function probe(cfg: AdapterCameraConfig): Promise<CameraCapabilities> {
    const startedAt = Date.now();
    const session = await negotiate(cfg);
    if (session.resourceUrl !== null) await teardown(session);

    // Resolution and fps are not in an SDP answer — they are properties of the RTP stream the
    // browser receives. Reporting null is correct; inventing them would be worse than useless.
    // The codec, however, *is* negotiated, so it is real.
    const codec = /a=rtpmap:\d+ (\w+)\//.exec(session.answerSdp)?.[1] ?? null;

    return {
      transport: 'whep',
      reachable: true,
      decodable: true,
      codec: codec === null ? null : codec.toLowerCase(),
      width: null,
      height: null,
      measuredFps: null,
      declaredFps: null,
      durationS: null,
      seekable: false,
      encrypted: true, // WebRTC media is always DTLS-SRTP encrypted.
      probeMs: Date.now() - startedAt,
      probedAt: new Date().toISOString(),
    };
  }

  async function teardown(session: WhepSession): Promise<void> {
    if (session.resourceUrl === null) return;
    try {
      await doFetch(session.resourceUrl, { method: 'DELETE' });
    } catch {
      // A failed teardown is not worth surfacing: the server times the session out anyway, and a
      // preview that closed is not an incident.
    }
  }

  async function open(cfg: AdapterCameraConfig): Promise<StreamHandle> {
    const session = await negotiate(cfg);
    return {
      cameraId: cfg.externalId,
      transport: 'whep',
      url: urlFor(cfg),
      startOffsetS: 0,
      // Null by design: WHEP media goes peer-to-peer to the browser, not through this process.
      stdout: null,
      closed: Promise.resolve(0),
      close: async () => {
        await teardown(session);
      },
    };
  }

  async function close(handle: StreamHandle): Promise<void> {
    await handle.close();
  }

  async function health(cfg: AdapterCameraConfig): Promise<HealthSample> {
    const startedAt = Date.now();
    try {
      const caps = await probe(cfg);
      return {
        transport: 'whep',
        connectable: true,
        decodable: caps.decodable,
        measuredFps: null,
        actualResolution: null,
        actualCodec: caps.codec,
        latencyMs: Date.now() - startedAt,
        error: null,
        checkedAt: new Date().toISOString(),
      };
    } catch (error) {
      return {
        transport: 'whep',
        connectable: false,
        decodable: false,
        measuredFps: null,
        actualResolution: null,
        actualCodec: null,
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        checkedAt: new Date().toISOString(),
      };
    }
  }

  const adapter: WhepAdapter = {
    kind: 'whep',
    description: 'WHEP signalling — sub-second WebRTC preview, media peer-to-peer to the browser',
    status: 'demonstrated',
    probe,
    open,
    close,
    health,
    negotiate,
  };

  return adapter;
}
