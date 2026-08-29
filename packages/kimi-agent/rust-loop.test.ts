import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  classifyRpcMessage,
  createLlmAbortRegistry,
  mapStopReason,
  projectHostMessageToWire,
} from './rust-loop';

describe('classifyRpcMessage', () => {
  it('classifies a host request (method + id) as a request', () => {
    expect(
      classifyRpcMessage({ jsonrpc: '2.0', id: 1, method: 'host/execute_tool', params: {} }),
    ).toBe('request');
  });

  it('classifies a result response (id, no method) as a response', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', id: 1, result: {} })).toBe('response');
  });

  it('classifies an error response (id, no method) as a response', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', id: 1, error: { code: -1, message: 'x' } })).toBe(
      'response',
    );
  });

  // Regression: a Rust host request carrying an id that collides with a pending
  // request id (both sides allocate ids from 1) must route as a request, not be
  // mis-consumed as the pending request's response.
  it('routes a colliding host request as a request, not a response', () => {
    const colliding = { jsonrpc: '2.0' as const, id: 1, method: 'host/llm_chat', params: {} };
    expect(classifyRpcMessage(colliding)).toBe('request');
  });

  it('ignores a notification (method, no id)', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0', method: 'host/log', params: {} })).toBe('ignore');
  });

  it('ignores a message with neither method nor id', () => {
    expect(classifyRpcMessage({ jsonrpc: '2.0' })).toBe('ignore');
  });
});

describe('mapStopReason', () => {
  it('maps EndTurn to completed', () => {
    expect(mapStopReason('EndTurn')).toBe('completed');
  });

  it('maps MaxTokens to truncated', () => {
    expect(mapStopReason('MaxTokens')).toBe('truncated');
  });

  it('maps Filtered to filtered', () => {
    expect(mapStopReason('Filtered')).toBe('filtered');
  });

  it('maps Paused to paused', () => {
    expect(mapStopReason('Paused')).toBe('paused');
  });

  it('maps Aborted to other', () => {
    expect(mapStopReason('Aborted')).toBe('other');
  });

  it('maps BudgetLimited to other', () => {
    expect(mapStopReason('BudgetLimited')).toBe('other');
  });

  it('maps unknown reason to other', () => {
    expect(mapStopReason('SomethingElse')).toBe('other');
  });

  it('maps empty string to other', () => {
    expect(mapStopReason('')).toBe('other');
  });
});

describe('projectHostMessageToWire', () => {
  it('projects text parts and joins them into content', () => {
    const wire = projectHostMessageToWire({
      role: 'user',
      content: [{ type: 'text', text: 'hello ' }, { type: 'text', text: 'world' }],
    });
    expect(wire.role).toBe('user');
    expect(wire.content).toBe('hello world');
    expect(wire.blocks).toBeUndefined();
  });

  it('drops think parts from the wire (reasoning hosted separately)', () => {
    const wire = projectHostMessageToWire({
      role: 'assistant',
      content: [
        { type: 'text', text: 'answer' },
        { type: 'think', think: 'internal reasoning' },
      ],
    });
    expect(wire.content).toBe('answer');
    expect(wire.blocks).toBeUndefined();
  });

  it('projects image/audio/video blocks with their urls', () => {
    const wire = projectHostMessageToWire({
      role: 'user',
      content: [
        { type: 'image_url', imageUrl: { url: 'https://e.com/a.png', id: 'i1' } },
        { type: 'audio_url', audioUrl: { url: 'https://e.com/a.mp3', id: 'a1' } },
        { type: 'video_url', videoUrl: { url: 'https://e.com/v.mp4', id: 'v1' } },
      ],
    });
    expect(wire.content).toBe('');
    expect(wire.blocks).toEqual([
      { type: 'image_url', url: 'https://e.com/a.png' },
      { type: 'audio_url', url: 'https://e.com/a.mp3', id: 'a1' },
      { type: 'video_url', url: 'https://e.com/v.mp4', id: 'v1' },
    ]);
  });

  it('skips malformed parts and unknown part types', () => {
    const wire = projectHostMessageToWire({
      role: 'user',
      content: [
        { type: 'text', text: 'ok' },
        { type: 'text' } as never,
        { type: 'image_url', imageUrl: { url: undefined } } as never,
        { type: 'hologram', data: 'x' } as never,
      ],
    });
    expect(wire.content).toBe('ok');
    expect(wire.blocks).toBeUndefined();
  });

  it('projects tool_calls and tool_call_id', () => {
    const wire = projectHostMessageToWire({
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'c1', name: 'Read', arguments: '{"path":"/a"}' }],
    });
    expect(wire.tool_calls).toEqual([
      { id: 'c1', name: 'Read', arguments: { path: '/a' } },
    ]);
    expect(wire.blocks).toBeUndefined();
  });

  it('serializes null tool arguments as an empty object', () => {
    const wire = projectHostMessageToWire({
      role: 'assistant',
      content: [],
      toolCalls: [{ id: 'c2', name: 'Bash', arguments: null }],
    });
    expect(wire.tool_calls).toEqual([{ id: 'c2', name: 'Bash', arguments: {} }]);
  });
});

// ── stdio transport: host/check_permission JS-side handler ────────────────

const kimiAgentPkgDir = resolve(import.meta.dirname);

function hasStdioCliBinary(): boolean {
  const ext = process.platform === 'win32' ? '.exe' : '';
  return (
    existsSync(join(kimiAgentPkgDir, 'target', 'release', `kimi-agent-cli${ext}`)) ||
    existsSync(join(kimiAgentPkgDir, 'target', 'debug', `kimi-agent-cli${ext}`))
  );
}

describe.skipIf(!hasStdioCliBinary())('stdio transport — host/check_permission JS handler', () => {
  const tempDirs: string[] = [];

  // `engineOverride` is the `@moonshot-ai/agent-core-v2` TurnEngine contract.
  // We import the type via the runtime module to keep this test file free of
  // a build-time dependency on the workspace package (kimi-agent has no
  // workspace dependency of its own).
  type TurnEngineInputLike = Parameters<Awaited<ReturnType<typeof import('./rust-loop').createRunTurnOverride>> extends infer E ? E extends (...args: infer A) => unknown ? (...args: A) => unknown : never : never>[0];

  afterEach(async () => {
    const { shutdownRustEngine } = await import('./rust-loop');
    shutdownRustEngine();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  async function driveWriteTurn(
    workspace: string,
    permission: { decision: 'allow' | 'deny'; reason?: string },
  ): Promise<{
    events: unknown[];
    permissionCalls: Array<{ name: string; arguments: unknown }>;
    hostToolExecutions: number;
    fileExisted: boolean;
    fileContent: string | null;
    result: unknown;
  }> {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
    mod.forceEngineTransport('stdio');
    const engine = mod.createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      shellPath: undefined,
    });
    expect(engine).toBeDefined();

    const events: unknown[] = [];
    const permissionCalls: Array<{ name: string; arguments: unknown }> = [];
    let hostToolExecutions = 0;
    let llmCallCount = 0;

    const input = {
      turnId: 1,
      signal: new AbortController().signal,
      llm: {
        modelName: 'test-model',
        systemPrompt: 'You are a test driver.',
        async chat() {
          const call = llmCallCount++;
          if (call === 0) {
            return {
              toolCalls: [
                {
                  type: 'function',
                  id: 'call-stdio-write',
                  name: 'Write',
                  arguments: JSON.stringify({ path: 'stdio-seam.txt', content: 'seam check\n' }),
                },
              ],
              providerFinishReason: 'tool_calls',
              usage: { inputOther: 10, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
            };
          }
          return {
            toolCalls: [],
            providerFinishReason: 'stop',
            usage: { inputOther: 5, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          };
        },
      },
      async buildMessages() {
        return [];
      },
      buildTools() {
        return [];
      },
      async dispatchEvent(event: unknown) {
        events.push(event);
      },
      async executeTool() {
        hostToolExecutions += 1;
        return { output: 'UNREACHABLE host fallback', isError: true };
      },
      async checkToolPermission(call: { name: string; arguments: unknown }) {
        permissionCalls.push({ name: call.name, arguments: call.arguments });
        return permission;
      },
    } satisfies TurnEngineInputLike;

    const result = await (engine as (i: TurnEngineInputLike) => Promise<unknown>)(input);

    const filePath = join(workspace, 'stdio-seam.txt');
    const { existsSync } = await import('node:fs');
    return {
      events,
      permissionCalls,
      hostToolExecutions,
      fileExisted: existsSync(filePath),
      fileContent: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
      result,
    };
  }

  it('routes native Write through host permission checker (allow → file lands natively)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-stdio-allow-'));
    tempDirs.push(workspace);

    const out = await driveWriteTurn(workspace, { decision: 'allow' });

    expect(out.permissionCalls).toHaveLength(1);
    expect(out.permissionCalls[0].name).toBe('Write');
    expect(out.hostToolExecutions).toBe(0, 'native write must not fall back to host executeTool');
    expect(out.fileExisted).toBe(true);
    expect(out.fileContent).toBe('seam check\n');
    // Rust emits tool.native on both allow and deny; the JS handler must
    // surface it via dispatchEvent as tool.call + tool.result.
    const toolCallEvents = out.events.filter(
      (e) => typeof e === 'object' && e !== null && (e as { type?: string }).type === 'tool.call',
    );
    const toolResultEvents = out.events.filter(
      (e) => typeof e === 'object' && e !== null && (e as { type?: string }).type === 'tool.result',
    );
    expect(toolCallEvents).toHaveLength(1);
    expect(toolResultEvents).toHaveLength(1);
    // CountingCallbacks fires for every host event (tool.native included);
    // validate the stdio CountingCallbacks → RunTurnResult.events_emitted
    // → adapter telemetry.eventsEmitted seam.
    const telemetry = (out.result as { telemetry?: { eventsEmitted: number } }).telemetry;
    expect(typeof telemetry?.eventsEmitted).toBe('number');
    expect(telemetry.eventsEmitted).toBeGreaterThanOrEqual(1);
  });

  it('routes native Write through host permission checker (deny → no file, refusal is the result)', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-stdio-deny-'));
    tempDirs.push(workspace);

    const out = await driveWriteTurn(workspace, {
      decision: 'deny',
      reason: 'user declined in this E2E',
    });

    expect(out.permissionCalls).toHaveLength(1);
    expect(out.permissionCalls[0].name).toBe('Write');
    expect(out.hostToolExecutions).toBe(0, 'denied calls must not fall back to host executeTool');
    expect(out.fileExisted).toBe(false);
    const toolResultEvents = out.events
      .filter(
        (e) => typeof e === 'object' && e !== null && (e as { type?: string }).type === 'tool.result',
      )
      .map((e) => e as { result?: { isError?: boolean; output?: unknown } });
    expect(toolResultEvents).toHaveLength(1);
    expect(toolResultEvents[0].result?.isError).toBe(true);
  });

  it('aborts a running turn at the next step boundary', async () => {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
    mod.forceEngineTransport('stdio');
    const engine = mod.createRunTurnOverride();
    expect(engine).toBeDefined();

    const controller = new AbortController();
    let chatCallCount = 0;
    const input = {
      turnId: 2,
      signal: controller.signal,
      llm: {
        modelName: 'test-model',
        systemPrompt: 'test',
        async chat({ signal: chatSignal }: { signal: AbortSignal }) {
          const call = chatCallCount++;
          await new Promise<void>((r) => chatSignal.addEventListener('abort', () => r()));
          return {
            toolCalls: [
              {
                type: 'function',
                id: 'tc-cancel',
                name: 'Read',
                arguments: '{"path":"a.txt"}',
              },
            ],
            providerFinishReason: 'tool_calls',
            usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          };
        },
      },
      async buildMessages() {
        return [];
      },
      buildTools() {
        return [];
      },
      async dispatchEvent() {},
      async executeTool() {
        return { output: 'ok' };
      },
    } satisfies TurnEngineInputLike;

    const inFlight = (engine as (i: TurnEngineInputLike) => Promise<unknown>)(input);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await inFlight;

    expect((result as { stopReason: string }).stopReason).toBe('other');
    expect((result as { steps: number }).steps).toBe(1);
    expect(chatCallCount).toBe(1);
  });
});

// ── napi adapter layer cancellation ─────────────────────────────────────

const napiEntry = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('node:fs').readdirSync(import.meta.dirname).find(
      (f: string) => f.endsWith('.node') && f.startsWith('kimi_agent'),
    );
  } catch {
    return undefined;
  }
})();

describe.skipIf(!napiEntry)('createRunTurnOverride — napi adapter cancellation', () => {
  // Reset the adapter's internal engine-mode state so the test selects napi
  // even when the .node is also present.
  beforeEach(async () => {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
  });

  afterEach(async () => {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
  });

  it('aborts a running turn via the adapter onAbort → cancelTurn wiring', { timeout: 15_000 }, async () => {
    const { createRunTurnOverride } = await import('./rust-loop');
    // Pin napi so the test exercises the napi cancelTurn path even when a
    // stdio CLI binary is also available.
    (await import('./rust-loop')).forceEngineTransport('napi');

    const controller = new AbortController();
    let chatCallCount = 0;
    const input = {
      turnId: 100,
      signal: controller.signal,
      llm: {
        modelName: 'test-model',
        systemPrompt: 'test',
        async chat({ signal: chatSignal }: { signal: AbortSignal }) {
          chatCallCount += 1;
          await new Promise<void>((r) => chatSignal.addEventListener('abort', () => r()));
          return {
            toolCalls: [
              {
                type: 'function',
                id: 'tc-cancel',
                name: 'Read',
                arguments: '{"path":"a.txt"}',
              },
            ],
            providerFinishReason: 'tool_calls',
            usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 },
          };
        },
      },
      async buildMessages() {
        return [];
      },
      buildTools() {
        return [];
      },
      async dispatchEvent() {},
      async executeTool() {
        return { output: 'ok' };
      },
    };

    const engine = createRunTurnOverride();
    expect(engine).toBeDefined();

    const inFlight = (engine as (i: typeof input) => Promise<unknown>)(input);
    await new Promise((r) => setTimeout(r, 20));
    controller.abort();
    const result = await inFlight;

    // napi cancelTurn sets CANCEL_MAP's AtomicBool; the loop checks it at the
    // next step top → Aborted → mapStopReason('Aborted') === 'other'.
    expect((result as { stopReason: string }).stopReason).toBe('other');
    expect((result as { steps: number }).steps).toBe(1);
    expect(chatCallCount).toBe(1);
  });
});

describe('createLlmAbortRegistry — MultiLLM loser cancellation', () => {
  it('aborts an in-flight request when it loses the race', () => {
    const registry = createLlmAbortRegistry();
    const request = registry.begin('llm-slow-1');

    expect(request.signal).toBeDefined();
    expect(request.signal?.aborted).toBe(false);

    registry.cancel('llm-slow-1');

    expect(request.signal?.aborted).toBe(true);
    request.finish();
  });

  it('leaves the winner alone', () => {
    const registry = createLlmAbortRegistry();
    const loser = registry.begin('llm-slow-1');
    const winner = registry.begin('llm-fast-2');

    registry.cancel('llm-slow-1');

    expect(loser.signal?.aborted).toBe(true);
    expect(winner.signal?.aborted).toBe(false);
  });

  it('applies a cancel that overtakes its request', () => {
    // The cancel and the request travel on separate channels, so the id can
    // arrive before the request it refers to.
    const registry = createLlmAbortRegistry();
    registry.cancel('llm-slow-9');

    const request = registry.begin('llm-slow-9');

    expect(request.signal?.aborted).toBe(true);
    request.finish();
  });

  it('gives unnamed requests no signal of their own', () => {
    // Single-provider turns are governed by the turn's own signal.
    const registry = createLlmAbortRegistry();
    const request = registry.begin(undefined);

    expect(request.signal).toBeUndefined();
    expect(() => request.finish()).not.toThrow();
  });
});
