import {
  UnreachableError,
  type AdapterCameraConfig,
  type CameraAdapter,
  type CameraCapabilities,
  type HealthSample,
  type OpenOptions,
  type StreamHandle,
} from './types.js';
import { createRtspAdapter } from './rtsp.js';

/**
 * ONVIF adapter — **demonstrated, not operational**.
 *
 * ONVIF is a discovery and control protocol, not a media transport: `GetProfiles` then
 * `GetStreamUri` yields an **RTSP URL**, and the media path from there is RTSP. So this adapter's
 * real work is the SOAP conversation, after which it delegates to the RTSP adapter rather than
 * duplicating it. That delegation is itself the argument for the interface — two transports, one
 * media implementation.
 *
 * Why it matters for a multi-department estate: ONVIF is how you onboard a camera whose stream URL
 * nobody wrote down. Vendors bury it in per-model path templates (`/cam/realmonitor?channel=1`,
 * `/Streaming/Channels/101`, `/live/ch0`), and a department that has lost the documentation can
 * still be onboarded by asking the device. That is the difference between a registry you can build
 * and one you cannot.
 *
 * **Verification honesty:** MediaMTX is not an ONVIF device and serves no SOAP, so the discovery
 * path is verified against a mock ONVIF device the test starts, which returns a real MediaMTX RTSP
 * URI — and the stream is then genuinely opened against MediaMTX. Discovery logic and media path
 * are both exercised; neither is exercised against the government feed, which speaks no ONVIF.
 */

export interface OnvifAdapterOptions {
  /** Injected in tests to point at the mock device. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface OnvifProfile {
  token: string;
  name: string;
}

const SOAP_ENVELOPE = (body: string): string =>
  `<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:trt="http://www.onvif.org/ver10/media/wsdl"
            xmlns:tt="http://www.onvif.org/ver10/schema">
  <s:Body>${body}</s:Body>
</s:Envelope>`;

/** Namespace-agnostic tag reader. ONVIF vendors differ on prefixes; matching on local name works. */
function extractAll(xml: string, localName: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${localName}[^>]*>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, 'g');
  return [...xml.matchAll(re)].map((m) => (m[1] ?? '').trim());
}

function extractAttr(xml: string, localName: string, attr: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${localName}[^>]*\\b${attr}="([^"]*)"`, 'g');
  return [...xml.matchAll(re)].map((m) => m[1] ?? '');
}

/**
 * ONVIF exposes its discovery steps beyond the shared interface, because they are separately
 * useful: an operator onboarding a camera wants to *see* the profiles a device advertises before
 * committing to one, and `resolve()` is what the registry stores. Neither belongs on
 * `CameraAdapter` — no other transport has profiles.
 */
export interface OnvifAdapter extends CameraAdapter {
  getProfiles(cfg: AdapterCameraConfig): Promise<OnvifProfile[]>;
  /** Device -> profile -> RTSP URL, returned as an rtsp-kind config. */
  resolve(cfg: AdapterCameraConfig): Promise<AdapterCameraConfig>;
}

export function createOnvifAdapter(options: OnvifAdapterOptions = {}): OnvifAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  // Media is RTSP once discovery is done. Delegating rather than reimplementing is the point.
  const rtsp = createRtspAdapter();

  const serviceUrl = (cfg: AdapterCameraConfig): string => {
    const url = cfg.endpoints['onvif'] ?? cfg.endpoints['service'];
    if (url === undefined || url === '') {
      throw new UnreachableError(
        `camera ${cfg.externalId} has no 'onvif' service endpoint in its registry row`,
        cfg.externalId,
        'onvif',
      );
    }
    return url;
  };

  async function soap(url: string, body: string, cameraId: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await doFetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/soap+xml; charset=utf-8' },
        body: SOAP_ENVELOPE(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new UnreachableError(
          `ONVIF device for ${cameraId} returned HTTP ${String(response.status)}`,
          cameraId,
          'onvif',
        );
      }
      return await response.text();
    } catch (error) {
      if (error instanceof UnreachableError) throw error;
      throw new UnreachableError(
        `ONVIF device for ${cameraId} is not reachable`,
        cameraId,
        'onvif',
        error,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** `GetProfiles` — a device advertises several, typically one high-res and one low-res. */
  async function getProfiles(cfg: AdapterCameraConfig): Promise<OnvifProfile[]> {
    const xml = await soap(serviceUrl(cfg), '<trt:GetProfiles/>', cfg.externalId);
    const tokens = extractAttr(xml, 'Profiles', 'token');
    const names = extractAll(xml, 'Name');
    return tokens.map((token, i) => ({ token, name: names[i] ?? token }));
  }

  /**
   * `GetStreamUri` for a profile → the RTSP URL.
   *
   * The first profile is taken by default because on essentially every device profile 0 is the
   * main (highest-resolution) stream, which is what ANPR needs. A camera whose substream is wanted
   * instead can pin it with an `onvifProfile` endpoint entry.
   */
  async function getStreamUri(cfg: AdapterCameraConfig, profileToken: string): Promise<string> {
    const xml = await soap(
      serviceUrl(cfg),
      `<trt:GetStreamUri>
         <trt:StreamSetup>
           <tt:Stream>RTP-Unicast</tt:Stream>
           <tt:Transport><tt:Protocol>RTSP</tt:Protocol></tt:Transport>
         </trt:StreamSetup>
         <trt:ProfileToken>${profileToken}</trt:ProfileToken>
       </trt:GetStreamUri>`,
      cfg.externalId,
    );
    const uri = extractAll(xml, 'Uri')[0];
    if (uri === undefined || uri === '') {
      throw new UnreachableError(
        `ONVIF device for ${cfg.externalId} returned no stream URI for profile ${profileToken}`,
        cfg.externalId,
        'onvif',
      );
    }
    return uri;
  }

  /** Discovery, end to end: device → profile → RTSP URL. */
  async function resolve(cfg: AdapterCameraConfig): Promise<AdapterCameraConfig> {
    const pinned = cfg.endpoints['onvifProfile'];
    const profiles = await getProfiles(cfg);
    const chosen = pinned ?? profiles[0]?.token;
    if (chosen === undefined) {
      throw new UnreachableError(
        `ONVIF device for ${cfg.externalId} advertised no media profiles`,
        cfg.externalId,
        'onvif',
      );
    }
    const rtspUrl = await getStreamUri(cfg, chosen);
    return { ...cfg, adapterKind: 'rtsp', endpoints: { ...cfg.endpoints, rtsp: rtspUrl } };
  }

  async function probe(cfg: AdapterCameraConfig): Promise<CameraCapabilities> {
    const resolved = await resolve(cfg);
    const caps = await rtsp.probe(resolved);
    // Report the transport the operator onboarded through, not the one media happened to arrive
    // over — otherwise the registry loses the fact that this camera was discovered, not configured.
    return { ...caps, transport: 'onvif' };
  }

  async function open(cfg: AdapterCameraConfig, opts: OpenOptions = {}): Promise<StreamHandle> {
    const resolved = await resolve(cfg);
    const handle = await rtsp.open(resolved, opts);
    return { ...handle, transport: 'onvif' };
  }

  async function close(handle: StreamHandle): Promise<void> {
    await handle.close();
  }

  async function health(cfg: AdapterCameraConfig): Promise<HealthSample> {
    const startedAt = Date.now();
    try {
      const resolved = await resolve(cfg);
      const sample = await rtsp.health(resolved);
      return { ...sample, transport: 'onvif' };
    } catch (error) {
      return {
        transport: 'onvif',
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

  const adapter: OnvifAdapter = {
    kind: 'onvif',
    description: 'ONVIF discovery — GetProfiles then GetStreamUri, media delegated to RTSP',
    status: 'demonstrated',
    probe,
    open,
    close,
    health,
    getProfiles,
    resolve,
  };

  return adapter;
}
