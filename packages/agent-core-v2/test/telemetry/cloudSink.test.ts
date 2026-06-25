import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CloudSink, type CloudSinkOptions } from '#/telemetry/cloudSink';

interface CapturedRequest {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: {
    readonly user_id: string;
    readonly events: readonly Record<string, unknown>[];
  };
}

type Responder = (req: CapturedRequest) => Response | Promise<Response>;

function makeFetch(responder: Responder): typeof fetch {
  return (async (input: unknown, init: unknown) => {
    const requestInit = init as { headers: Record<string, string>; body: string };
    const req: CapturedRequest = {
      url: String(input),
      headers: requestInit.headers,
      body: JSON.parse(requestInit.body) as CapturedRequest['body'],
    };
    return responder(req);
  }) as unknown as typeof fetch;
}

function okResponse(): Response {
  return new Response(null, { status: 200 });
}

function statusResponse(status: number): Response {
  return new Response(null, { status });
}

function baseOptions(overrides: Partial<CloudSinkOptions> = {}): CloudSinkOptions {
  return {
    homeDir: overrides.homeDir ?? '',
    deviceId: overrides.deviceId ?? 'dev',
    appName: overrides.appName ?? 'test-app',
    version: overrides.version ?? '1.0.0',
    env: overrides.env ?? {},
    sleep: overrides.sleep ?? (async () => {}),
    ...overrides,
  };
}

describe('CloudSink', () => {
  let homeDir: string;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'cloud-sink-'));
  });

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true });
  });

  it('sends a flattened, prefixed payload with user_id and context', async () => {
    const requests: CapturedRequest[] = [];
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        deviceId: 'dev123',
        sessionId: 'sess1',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    sink.track('tool.call', { name: 'bash', count: 2 });
    await sink.flush();

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('https://telemetry-logs.kimi.com/v1/event');
    expect(requests[0]?.body.user_id).toBe('kfc_device_id_dev123');
    const event = requests[0]?.body.events[0];
    expect(event?.['event']).toBe('kfc_tool.call');
    expect(event?.['device_id']).toBe('dev123');
    expect(event?.['session_id']).toBe('sess1');
    expect(event?.['property_name']).toBe('bash');
    expect(event?.['property_count']).toBe(2);
    expect(event?.['context_app_name']).toBe('test-app');
    expect(event?.['context_version']).toBe('1.0.0');
    expect(typeof event?.['event_id']).toBe('string');
    expect(typeof event?.['timestamp']).toBe('number');
  });

  it('sends Authorization header when a token is provided', async () => {
    const requests: CapturedRequest[] = [];
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        getAccessToken: () => 'tok123',
        fetchImpl: makeFetch((req) => {
          requests.push(req);
          return okResponse();
        }),
      }),
    );

    sink.track('evt');
    await sink.flush();

    expect(requests[0]?.headers['Authorization']).toBe('Bearer tok123');
  });

  it('auto-flushes when the buffer reaches the threshold', async () => {
    let sends = 0;
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        flushThreshold: 3,
        fetchImpl: makeFetch(() => {
          sends += 1;
          return okResponse();
        }),
      }),
    );

    sink.track('e1');
    sink.track('e2');
    expect(sends).toBe(0);
    sink.track('e3');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(1);
  });

  it('shutdown flushes the remaining buffered events', async () => {
    let sends = 0;
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          sends += 1;
          return okResponse();
        }),
      }),
    );

    sink.track('e1');
    await sink.shutdown();
    expect(sends).toBe(1);
  });

  it('retries on 5xx and saves to disk after exhausting backoffs', async () => {
    let attempts = 0;
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => {
          attempts += 1;
          return statusResponse(500);
        }),
      }),
    );

    sink.track('evt');
    await sink.flush();

    expect(attempts).toBe(4);
    const files = readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_'));
    expect(files).toHaveLength(1);
  });

  it('retries a 401 once without the Authorization header', async () => {
    const seenAuths: (string | undefined)[] = [];
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        getAccessToken: () => 'tok',
        fetchImpl: makeFetch((req) => {
          seenAuths.push(req.headers['Authorization']);
          if (req.headers['Authorization'] !== undefined) {
            return statusResponse(401);
          }
          return okResponse();
        }),
      }),
    );

    sink.track('evt');
    await sink.flush();

    expect(seenAuths).toEqual(['Bearer tok', undefined]);
  });

  it('retryDiskEvents resends saved events and removes the file on success', async () => {
    let shouldFail = true;
    const sink = new CloudSink(
      baseOptions({
        homeDir,
        fetchImpl: makeFetch(() => (shouldFail ? statusResponse(500) : okResponse())),
      }),
    );

    sink.track('evt');
    await sink.flush();
    expect(
      readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_')),
    ).toHaveLength(1);

    shouldFail = false;
    await sink.retryDiskEvents();
    expect(
      readdirSync(join(homeDir, 'telemetry')).filter((f) => f.startsWith('failed_')),
    ).toHaveLength(0);
  });
});
