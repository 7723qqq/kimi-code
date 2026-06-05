/**
 * Prompts end-to-end tests (W7.2 / Chain 4 / P1.4).
 *
 * **Bootstrap strategy**: spawn the real daemon (port 0, tmp lock + bridge
 * home) and exercise:
 *   1. POST /api/v1/sessions/{sid}/prompts validation (40001 on bad body, 40401
 *      on bad sid).
 *   2. Lifecycle event synthesis: register a fake active prompt directly on
 *      the IPromptService (so we don't have to drive agent-core through the
 *      bridge.rpc.prompt path, which requires provider creds). Publish
 *      `turn.started` → `assistant.delta` × N → `turn.ended` directly through
 *      the event bus. Verify a WS subscriber receives them all PLUS the
 *      synthesized `prompt.completed`.
 *
 * We don't drive a REAL prompt through agent-core in this test because:
 *   - prompt execution requires provider credentials + network IO.
 *   - the architecture under test is the daemon's event-bus synthesis +
 *     fan-out path, not the model's behavior.
 *   - the services-layer unit tests at
 *     `packages/services/test/prompt-service.test.ts` exercise the protocol
 *     → kosong content adapter against a mocked bridge.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { pino } from 'pino';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import type { Event } from '@moonshot-ai/protocol';
import { IEventBus, IPromptService, PromptServiceImpl } from '@moonshot-ai/services';

import { IRestGateway, startDaemon, type RunningDaemon } from '../src';

let tmpDir: string;
let lockPath: string;
let bridgeHome: string;
let daemon: RunningDaemon | undefined;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'kimi-daemon-prompts-test-'));
  lockPath = join(tmpDir, 'lock');
  bridgeHome = mkdtempSync(join(tmpdir(), 'kimi-daemon-prompts-home-'));
});

afterEach(async () => {
  try {
    await daemon?.close();
  } catch {
    // ignore
  }
  daemon = undefined;
  rmSync(tmpDir, { recursive: true, force: true });
  rmSync(bridgeHome, { recursive: true, force: true });
});

async function bootDaemon(): Promise<RunningDaemon> {
  daemon = await startDaemon({
    host: '127.0.0.1',
    port: 0,
    lockPath,
    logger: pino({ level: 'silent' }),
    bridgeOptions: { homeDir: bridgeHome },
    wsGatewayOptions: { pingIntervalMs: 5_000, pongTimeoutMs: 5_000 },
  });
  return daemon;
}

function appOf(r: RunningDaemon): {
  inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
} {
  return r.services.invokeFunction((a) => {
    const gw = a.get(IRestGateway);
    return gw.app as unknown as {
      inject: (req: unknown) => Promise<{ statusCode: number; json: () => unknown }>;
    };
  });
}

function envelopeOf<T>(body: unknown): {
  code: number;
  msg: string;
  data: T | null;
  request_id: string;
  details?: unknown;
} {
  return body as {
    code: number;
    msg: string;
    data: T | null;
    request_id: string;
    details?: unknown;
  };
}

async function createSession(r: RunningDaemon): Promise<string> {
  const res = await appOf(r).inject({
    method: 'POST',
    url: '/api/v1/sessions',
    payload: { metadata: { cwd: join(tmpDir, 'workspace') } },
  });
  const env = envelopeOf<{ id: string }>(res.json());
  if (env.code !== 0 || env.data === null) {
    throw new Error(`create session failed: ${JSON.stringify(env)}`);
  }
  return env.data.id;
}

/**
 * Open a WS subscriber and wait for server_hello + client_hello ack.
 * Returns a handle exposing the received frame queue.
 *
 * Mirrors the queueing pattern from `ws-broadcast.e2e.test.ts` — message
 * listener is attached BEFORE the `open` event resolves, so frames that land
 * in the same tick as the upgrade aren't lost.
 */
async function openSubscriber(
  r: RunningDaemon,
  sid: string,
): Promise<{
  ws: WebSocket;
  received: Record<string, unknown>[];
}> {
  const wsUrl = r.address.replace('http://', 'ws://') + '/api/v1/ws';
  const received: Record<string, unknown>[] = [];
  const ws = await new Promise<WebSocket>((resolve, reject) => {
    const sock = new WebSocket(wsUrl);
    sock.on('message', (data) => {
      try {
        received.push(JSON.parse(String(data)) as Record<string, unknown>);
      } catch {
        // ignore
      }
    });
    sock.once('open', () => resolve(sock));
    sock.once('error', reject);
  });
  // Wait for server_hello.
  await waitFor(received, (f) => f['type'] === 'server_hello');
  ws.send(
    JSON.stringify({
      type: 'client_hello',
      id: 'h1',
      payload: { client_id: 'test', subscriptions: [sid] },
    }),
  );
  await waitFor(received, (f) => f['type'] === 'ack' && f['id'] === 'h1');
  return { ws, received };
}

async function waitFor(
  received: Record<string, unknown>[],
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const hit = received.find(pred);
    if (hit !== undefined) return hit;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(
    `waitFor timed out; received: ${received.map((f) => f['type']).join(', ')}`,
  );
}

describe('POST /api/v1/sessions/{sid}/prompts — submit validation (W7.2 / Chain 4)', () => {
  it('rejects an empty content array with 40001', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: { content: [] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
    expect(env.data).toBeNull();
    expect(Array.isArray(env.details)).toBe(true);
  });

  it('returns 40401 for an unknown session id', async () => {
    const r = await bootDaemon();
    const res = await appOf(r).inject({
      method: 'POST',
      url: '/api/v1/sessions/sess_missing/prompts',
      payload: { content: [{ type: 'text', text: 'hello' }] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40401);
  });

  it('rejects bad content shape with 40001 (no `type` field)', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const res = await appOf(r).inject({
      method: 'POST',
      url: `/api/v1/sessions/${sid}/prompts`,
      payload: { content: [{ text: 'no type' }] },
    });
    const env = envelopeOf<unknown>(res.json());
    expect(env.code).toBe(40001);
  });
});

describe('Prompt lifecycle: WS receives events + synthesized prompt.completed (W7.2)', () => {
  it('synthesizes prompt.completed end-to-end through bus → observer → WS', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const promptId = `prompt_TEST_${sid}`;
    const turnId = 42;

    // Inject an active-prompt record into the daemon's IPromptService so the
    // lifecycle observer recognizes turn.* events for this session. We skip
    // a real `bridge.rpc.prompt(...)` call because it would require provider
    // credentials + a fully-loaded agent.
    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptServiceImpl,
    );
    expect(impl).toBeInstanceOf(PromptServiceImpl);
    impl._injectActiveForTest(sid, promptId, null);

    // Publish the agent-core event stream directly through the bus.
    const eventBus = r.services.invokeFunction((a) => a.get(IEventBus));
    eventBus.publish({
      type: 'turn.started',
      turnId,
      origin: { kind: 'user' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'assistant.delta',
      turnId,
      delta: 'hi ',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'assistant.delta',
      turnId,
      delta: 'there',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'turn.ended',
      turnId,
      reason: 'completed',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    // Wait for the synthesized prompt.completed event on the WS.
    const promptCompletedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.completed',
      2000,
    );
    const payload = promptCompletedFrame['payload'] as {
      promptId: string;
      reason: string;
    };
    expect(payload.promptId).toBe(promptId);
    expect(payload.reason).toBe('completed');
    expect(promptCompletedFrame['session_id']).toBe(sid);

    // Verify the upstream events also arrived in order.
    const types = received.map((f) => f['type']);
    expect(types).toContain('turn.started');
    expect(types).toContain('assistant.delta');
    expect(types).toContain('turn.ended');
    expect(types).toContain('prompt.completed');
    // prompt.completed lands AFTER turn.ended (synthesized post-fan-out).
    const turnEndedIdx = types.lastIndexOf('turn.ended');
    const completedIdx = types.lastIndexOf('prompt.completed');
    expect(completedIdx).toBeGreaterThan(turnEndedIdx);

    ws.close();
  });

  it('synthesizes prompt.aborted when turn.ended (reason=cancelled) fires', async () => {
    const r = await bootDaemon();
    const sid = await createSession(r);
    const { ws, received } = await openSubscriber(r, sid);

    const promptId = `prompt_ABORT_TEST_${sid}`;
    const turnId = 7;

    const impl = r.services.invokeFunction(
      (a) => a.get(IPromptService) as PromptServiceImpl,
    );
    impl._injectActiveForTest(sid, promptId, null);

    const eventBus = r.services.invokeFunction((a) => a.get(IEventBus));
    eventBus.publish({
      type: 'turn.started',
      turnId,
      origin: { kind: 'user' },
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);
    eventBus.publish({
      type: 'turn.ended',
      turnId,
      reason: 'cancelled',
      sessionId: sid,
      agentId: 'main',
    } as unknown as Event);

    const abortedFrame = await waitFor(
      received,
      (f) => f['type'] === 'prompt.aborted',
      2000,
    );
    const payload = abortedFrame['payload'] as { promptId: string };
    expect(payload.promptId).toBe(promptId);

    ws.close();
  });
});
