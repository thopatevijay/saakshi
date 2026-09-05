/**
 * The evidence object store — MinIO, spoken to as plain S3.
 *
 * Three things this file is responsible for, and nothing else:
 *
 * 1. **The path convention.** `evidence/<camera_id>/<yyyy-mm-dd>/<sighting_id>-{vehicle,plate}.jpg`.
 *    A key that encodes camera and date is what makes a retention rule expressible as a prefix and
 *    a gap analysis expressible as a list, without a database round trip.
 * 2. **Signed access.** No object is ever public. Reads are pre-signed URLs with an explicit
 *    expiry, so a link that leaks out of a control room stops working.
 * 3. **Retention as configuration.** Lifecycle rules per prefix, loaded from
 *    `config/evidence-retention.json` and applied to the bucket — not a cron job that deletes
 *    things, which is a retention policy nobody can audit.
 *
 * ### Why SigV4 by hand rather than `@aws-sdk/client-s3`
 *
 * Two verbs and a presigner, against one endpoint we control, versus several megabytes of SDK and
 * its transitive tree. The signing algorithm is a published specification, it is exercised against
 * a real MinIO in `evidence.test.ts`, and doing it here is what lets `presignGet` state its expiry
 * in seconds and prove expiry in a test rather than trusting a client's defaults.
 *
 * Path-style addressing throughout (`/<bucket>/<key>`), because virtual-host style needs DNS
 * entries per bucket that a local MinIO does not have.
 */
import { createHash, createHmac } from 'node:crypto';

export const EVIDENCE_PREFIX = 'evidence';
export type EvidenceKind = 'vehicle' | 'plate';

export interface EvidenceStoreConfig {
  /** e.g. `http://localhost:9000`. No trailing slash. */
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** MinIO ignores it but signs with it, so it must match on both sides. */
  region?: string | undefined;
}

export interface StoredObject {
  key: string;
  size: number;
  etag?: string | undefined;
}

/**
 * `evidence/<camera_id>/<yyyy-mm-dd>/<sighting_id>-<kind>.jpg`.
 *
 * `camera_id` is the camera's **external** id (`cam01`), not its uuid. The external id is what the
 * upstream catalogue, the stream URLs, every operator and every screenshot already use; a bucket
 * keyed by uuid is one no human can navigate, and the uuid is one join away whenever it is needed.
 *
 * The date is the **sighting's** date in UTC, taken from its PTS-derived `ts` — never the upload
 * date. An object that lands after midnight because the consumer was catching up must retain under
 * the day it was seen, or the retention clock lies by a day at exactly the moment it matters.
 */
export function evidenceKey(input: {
  cameraExternalId: string;
  ts: Date | string;
  sightingId: string;
  kind: EvidenceKind;
}): string {
  const ts = input.ts instanceof Date ? input.ts : new Date(input.ts);
  const day = ts.toISOString().slice(0, 10);
  return `${EVIDENCE_PREFIX}/${input.cameraExternalId}/${day}/${input.sightingId}-${input.kind}.jpg`;
}

// ── SigV4 ─────────────────────────────────────────────────────────────────────────────────────

const ALGORITHM = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';
const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/**
 * RFC 3986, which is *not* what `encodeURIComponent` produces.
 *
 * `!`, `'`, `(`, `)` and `*` are left alone by `encodeURIComponent` and must be percent-encoded for
 * the canonical request, or the signature silently disagrees with the server's for any key
 * containing one. A sighting uuid never contains those characters — but a camera external id
 * supplied by an upstream catalogue could, and a signature that works until the day it does not is
 * worse than one that never worked.
 */
function uriEncode(value: string, encodeSlash = true): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

function amzDate(now: Date): { long: string; short: string } {
  const long = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '');
  return { long, short: long.slice(0, 8) };
}

function signingKey(secret: string, short: string, region: string): Buffer {
  return hmac(hmac(hmac(hmac(`AWS4${secret}`, short), region), SERVICE), 'aws4_request');
}

function canonicalQuery(params: Record<string, string>): string {
  return Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(params[k] ?? '')}`)
    .join('&');
}

export class EvidenceStore {
  private readonly endpoint: string;
  private readonly host: string;
  readonly bucket: string;
  private readonly region: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;

  constructor(config: EvidenceStoreConfig) {
    this.endpoint = config.endpoint.replace(/\/+$/, '');
    this.host = new URL(this.endpoint).host;
    this.bucket = config.bucket;
    this.region = config.region ?? 'us-east-1';
    this.accessKeyId = config.accessKeyId;
    this.secretAccessKey = config.secretAccessKey;
  }

  private path(key?: string): string {
    return key === undefined ? `/${this.bucket}` : `/${this.bucket}/${uriEncode(key, false)}`;
  }

  /** A header-signed request. Used for everything except the presigned read. */
  private async send(options: {
    method: string;
    key?: string;
    query?: Record<string, string>;
    body?: Buffer;
    headers?: Record<string, string>;
  }): Promise<Response> {
    const now = new Date();
    const { long, short } = amzDate(now);
    const body = options.body ?? Buffer.alloc(0);
    const payloadHash = sha256Hex(body);
    const canonicalUri = this.path(options.key);
    const query = canonicalQuery(options.query ?? {});

    const headers: Record<string, string> = {
      host: this.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': long,
      ...Object.fromEntries(
        Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };

    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]?.trim()}\n`).join('');
    const signedHeaderList = signedHeaders.join(';');

    const canonicalRequest = [
      options.method,
      canonicalUri,
      query,
      canonicalHeaders,
      signedHeaderList,
      payloadHash,
    ].join('\n');

    const scope = `${short}/${this.region}/${SERVICE}/aws4_request`;
    const stringToSign = [ALGORITHM, long, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(this.secretAccessKey, short, this.region))
      .update(stringToSign, 'utf8')
      .digest('hex');

    const url = `${this.endpoint}${canonicalUri}${query ? `?${query}` : ''}`;
    const init: RequestInit = {
      method: options.method,
      headers: {
        ...headers,
        Authorization: `${ALGORITHM} Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`,
      },
    };
    // `fetch` refuses a body on GET/HEAD even when it is empty, and under
    // `exactOptionalPropertyTypes` an explicit `undefined` is not the same as omitting the key.
    //
    // A detached `ArrayBuffer` rather than the `Buffer` itself.
    //
    // Under the API's node-only `lib`, a `Buffer` is a fine `BodyInit`. But `packages/web` also
    // compiles this file — `scripts/generate-api-types.mts` imports `buildServer`, and D2-06's
    // alert routes put the evidence store into that graph — and it compiles with `lib: DOM`, where
    // `BodyInit` is the DOM's and neither `Buffer<ArrayBufferLike>` nor `Uint8Array<ArrayBufferLike>`
    // is assignable to it (the DOM's `ArrayBufferView` is parameterised on `ArrayBuffer`, and a
    // node Buffer's backing store is `ArrayBufferLike`). A plain `ArrayBuffer` is a `BodyInit`
    // under both.
    //
    // It costs one copy of the object being uploaded. These are plate and vehicle crops — tens of
    // kilobytes — and the copy is bounded by the same 6 MB body limit the API already enforces.
    if (options.method !== 'GET' && options.method !== 'HEAD') {
      const bytes = new Uint8Array(body.byteLength);
      bytes.set(body);
      init.body = bytes.buffer;
    }
    return fetch(url, init);
  }

  /**
   * A pre-signed GET URL, valid for `expiresInSeconds`.
   *
   * Query-signed rather than header-signed, because the whole point is a URL an operator's browser
   * can follow with no credentials of its own. `UNSIGNED-PAYLOAD` is correct here and not a
   * shortcut: a GET has no body to hash, and the signature still covers the key, the expiry and
   * the host.
   *
   * Synchronous and offline — no network call — so an alert can embed one per crop without a round
   * trip to the object store.
   */
  presignGet(key: string, expiresInSeconds = 900, now: Date = new Date()): string {
    const { long, short } = amzDate(now);
    const scope = `${short}/${this.region}/${SERVICE}/aws4_request`;
    const params: Record<string, string> = {
      'X-Amz-Algorithm': ALGORITHM,
      'X-Amz-Credential': `${this.accessKeyId}/${scope}`,
      'X-Amz-Date': long,
      'X-Amz-Expires': String(Math.max(1, Math.floor(expiresInSeconds))),
      'X-Amz-SignedHeaders': 'host',
    };
    const canonicalUri = this.path(key);
    const canonicalRequest = [
      'GET',
      canonicalUri,
      canonicalQuery(params),
      `host:${this.host}\n`,
      'host',
      UNSIGNED_PAYLOAD,
    ].join('\n');
    const stringToSign = [ALGORITHM, long, scope, sha256Hex(canonicalRequest)].join('\n');
    const signature = createHmac('sha256', signingKey(this.secretAccessKey, short, this.region))
      .update(stringToSign, 'utf8')
      .digest('hex');
    return `${this.endpoint}${canonicalUri}?${canonicalQuery(params)}&X-Amz-Signature=${signature}`;
  }

  async putObject(key: string, body: Buffer, contentType = 'image/jpeg'): Promise<StoredObject> {
    const response = await this.send({
      method: 'PUT',
      key,
      body,
      headers: { 'content-type': contentType, 'content-length': String(body.byteLength) },
    });
    if (!response.ok)
      throw new Error(`PUT ${key} failed: ${response.status} ${await response.text()}`);
    return { key, size: body.byteLength, etag: response.headers.get('etag') ?? undefined };
  }

  async headObject(key: string): Promise<StoredObject | null> {
    const response = await this.send({ method: 'HEAD', key });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`HEAD ${key} failed: ${response.status}`);
    return {
      key,
      size: Number(response.headers.get('content-length') ?? 0),
      etag: response.headers.get('etag') ?? undefined,
    };
  }

  async deleteObject(key: string): Promise<void> {
    const response = await this.send({ method: 'DELETE', key });
    // 204 on success, 404 when it was never there — both mean "it is not there now".
    if (!response.ok && response.status !== 404) {
      throw new Error(`DELETE ${key} failed: ${response.status}`);
    }
  }

  /**
   * Every object under a prefix, following continuation tokens.
   *
   * This is the count the ticket's gate compares against the best-shot count, so it must not stop
   * at the first page: a 1,000-key ceiling that silently truncates would make an over-storing
   * bucket look correct.
   */
  async listObjects(prefix = `${EVIDENCE_PREFIX}/`, hardLimit = 100_000): Promise<StoredObject[]> {
    const out: StoredObject[] = [];
    let token: string | undefined;
    do {
      const query: Record<string, string> = {
        'list-type': '2',
        prefix,
        'max-keys': '1000',
      };
      if (token !== undefined) query['continuation-token'] = token;
      const response = await this.send({ method: 'GET', query });
      if (!response.ok) throw new Error(`LIST failed: ${response.status}`);
      const xml = await response.text();
      for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const chunk = match[1] ?? '';
        const key = /<Key>([\s\S]*?)<\/Key>/.exec(chunk)?.[1];
        const size = /<Size>(\d+)<\/Size>/.exec(chunk)?.[1];
        if (key !== undefined) out.push({ key: decodeXml(key), size: Number(size ?? 0) });
      }
      token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
      if (/<IsTruncated>false<\/IsTruncated>/.test(xml)) token = undefined;
    } while (token !== undefined && out.length < hardLimit);
    return out;
  }

  // ── Retention ───────────────────────────────────────────────────────────────────────────────

  /**
   * Apply the retention policy as an S3 lifecycle configuration.
   *
   * A bucket rule rather than a delete job, deliberately. Pillar 4 is the retention clock: an
   * officer has to be able to see *when* evidence expires, and a policy the store itself enforces
   * is one that can be read back and shown. A cron job that deletes rows is a policy that exists
   * only in whoever wrote it.
   */
  async putRetention(rules: RetentionRule[]): Promise<void> {
    const xml =
      `<?xml version="1.0" encoding="UTF-8"?>` +
      `<LifecycleConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/">` +
      rules
        .map(
          (rule) =>
            `<Rule><ID>${escapeXml(rule.id)}</ID><Status>${rule.enabled === false ? 'Disabled' : 'Enabled'}</Status>` +
            `<Filter><Prefix>${escapeXml(rule.prefix)}</Prefix></Filter>` +
            `<Expiration><Days>${Math.max(1, Math.floor(rule.retainDays))}</Days></Expiration></Rule>`,
        )
        .join('') +
      `</LifecycleConfiguration>`;
    const body = Buffer.from(xml, 'utf8');
    const response = await this.send({
      method: 'PUT',
      query: { lifecycle: '' },
      body,
      headers: {
        'content-type': 'application/xml',
        'content-length': String(body.byteLength),
        // AWS still documents Content-MD5 as required for this call and MinIO validates it when
        // present. Sending it costs one hash and removes a class of "works locally, 400s on S3".
        'content-md5': createHash('md5').update(body).digest('base64'),
      },
    });
    if (!response.ok) {
      throw new Error(`PUT lifecycle failed: ${response.status} ${await response.text()}`);
    }
  }

  /** The policy as the store itself reports it — read back, never assumed from what was sent. */
  async getRetention(): Promise<RetentionRule[]> {
    const response = await this.send({ method: 'GET', query: { lifecycle: '' } });
    if (response.status === 404) return [];
    if (!response.ok) throw new Error(`GET lifecycle failed: ${response.status}`);
    const xml = await response.text();
    const rules: RetentionRule[] = [];
    for (const match of xml.matchAll(/<Rule>([\s\S]*?)<\/Rule>/g)) {
      const chunk = match[1] ?? '';
      rules.push({
        id: decodeXml(/<ID>([\s\S]*?)<\/ID>/.exec(chunk)?.[1] ?? ''),
        prefix: decodeXml(/<Prefix>([\s\S]*?)<\/Prefix>/.exec(chunk)?.[1] ?? ''),
        retainDays: Number(/<Days>(\d+)<\/Days>/.exec(chunk)?.[1] ?? 0),
        enabled: !/<Status>Disabled<\/Status>/.test(chunk),
      });
    }
    return rules;
  }
}

export interface RetentionRule {
  id: string;
  /** Key prefix the rule applies to, e.g. `evidence/` or `evidence/cam01/`. */
  prefix: string;
  retainDays: number;
  enabled?: boolean | undefined;
  /** Free text carried in the config file for humans; never sent to the store. */
  note?: string | undefined;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/**
 * Build a store from the environment.
 *
 * Returns `null` rather than throwing when the credentials are absent: the API must start and serve
 * the registry on a machine with no object store, and a missing evidence bucket is a degraded
 * feature, not a boot failure.
 */
export function evidenceStoreFromEnv(env: NodeJS.ProcessEnv = process.env): EvidenceStore | null {
  const accessKeyId = env['MINIO_ACCESS_KEY'];
  const secretAccessKey = env['MINIO_SECRET_KEY'];
  if (!accessKeyId || !secretAccessKey) return null;
  return new EvidenceStore({
    endpoint: env['MINIO_ENDPOINT'] ?? 'http://localhost:9000',
    bucket: env['MINIO_BUCKET'] ?? 'saakshi-evidence',
    accessKeyId,
    secretAccessKey,
    region: env['MINIO_REGION'],
  });
}
