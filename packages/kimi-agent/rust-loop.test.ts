import { existsSync } from 'node:fs';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  AgentProcess,
  NapiEngine,
  classifyRpcMessage,
  createLlmAbortRegistry,
  mapStopReason,
  projectHostMessageToWire,
  type AskQuestionWire,
  type AskQuestionWireResult,
} from './rust-loop';
import { runTurnParamsSchema, runTurnResultSchema, telemetryEventSchema, turnEventSchema } from './wire-schema';

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
    opts: { resetEngine?: boolean } = {},
  ): Promise<{
    events: unknown[];
    permissionCalls: Array<{ name: string; arguments: unknown }>;
    hostToolExecutions: number;
    fileExisted: boolean;
    fileContent: string | null;
    result: unknown;
    observed: unknown;
  }> {
    const mod = await import('./rust-loop');
    // The engine's mode is sticky, so tests reset it to re-select a transport.
    // The crash-recovery test skips this: it needs the state left behind by
    // the crash it just induced.
    if (opts.resetEngine !== false) {
      mod.shutdownRustEngine();
      mod.forceEngineTransport('stdio');
    }
    let observed: unknown;
    const engine = mod.createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      shellPath: undefined,
      onTurnResult: (result) => {
        observed = result;
      },
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
        modelAlias: 'test-model',
        modelId: 'test-model',
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
      observed,
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
    // The host observer sees the turn the engine actually completed, which is
    // what the /status Engine row reports - same object, not a re-derivation.
    const observed = out.observed as {
      telemetry?: { nativeToolCallCount?: number; llmTransport?: string };
    };
    expect(out.observed).toBe(out.result);
    expect(observed.telemetry?.nativeToolCallCount).toBeGreaterThanOrEqual(1);
    expect(observed.telemetry?.llmTransport).toBe('host-proxy');
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

  it('recovers after the stdio engine process crashes', async () => {
    // A crash used to be terminal: the mode stayed 'stdio' with a null
    // process handle, so every later turn failed with "Agent process is not
    // running" until the CLI was restarted.
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
    mod.forceEngineTransport('stdio');

    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-crash-'));
    tempDirs.push(workspace);

    const first = await driveWriteTurn(workspace, { decision: 'allow' });
    expect(first.fileExisted).toBe(true);

    const pidBefore = (
      mod.activeAgentProcessForTests() as unknown as { process?: { pid?: number } } | null
    )?.process?.pid;
    expect(pidBefore).toBeDefined();

    mod.activeAgentProcessForTests()?.stop();
    // Give the 'exit' handler a tick to run and reset the engine mode.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const second = await driveWriteTurn(workspace, { decision: 'allow' }, { resetEngine: false });
    expect(second.fileExisted).toBe(true, 'a turn after a crash must still complete');

    const pidAfter = (
      mod.activeAgentProcessForTests() as unknown as { process?: { pid?: number } } | null
    )?.process?.pid;
    expect(pidAfter).toBeDefined();
    expect(pidAfter).not.toBe(pidBefore, 'a replacement process must have been spawned');
  });

  it('aborts a running turn at the next step boundary', { timeout: 15_000 }, async () => {
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
        modelAlias: 'test-model',
        modelId: 'test-model',
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
        modelAlias: 'test-model',
        modelId: 'test-model',
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

describe('native-LLM staleness guard', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Port 9 (discard) refuses connections instantly, so a turn that really
  // picks the native transport fails locally instead of reaching a provider.
  async function driveGuardTurn(opts: {
    alias: string;
    modelId: string;
    nativeModel: string;
  }): Promise<{ hostChatCalls: number; stopReason: string }> {
    const mod = await import('./rust-loop');
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-native-llm-guard-'));
    tempDirs.push(workspace);
    mod.shutdownRustEngine();
    mod.forceEngineTransport('stdio');

    const engine = mod.createRunTurnOverride(undefined, workspace, {
      nativeTools: false,
      shellPath: undefined,
      nativeLlm: () => ({
        protocol: 'openai' as const,
        base_url: 'http://127.0.0.1:9/v1',
        api_key: 'sk-test',
        model: opts.nativeModel,
      }),
    });
    expect(engine).toBeDefined();

    let hostChatCalls = 0;
    const input = {
      turnId: 1,
      signal: new AbortController().signal,
      llm: {
        modelAlias: opts.alias,
        modelId: opts.modelId,
        systemPrompt: 'test',
        async chat() {
          hostChatCalls += 1;
          return {
            toolCalls: [],
            providerFinishReason: 'stop',
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

    let stopReason = 'rejected';
    try {
      const result = await (engine as (i: typeof input) => Promise<{ stopReason: string }>)(input);
      stopReason = result.stopReason;
    } catch {
      // The native transport exhausted its retries against a dead port.
    }
    return { hostChatCalls, stopReason };
  }

  it(
    'keeps the native transport when the wire model id matches a prefixed alias',
    { timeout: 30_000 },
    async () => {
      const { hostChatCalls, stopReason } = await driveGuardTurn({
        alias: 'provider-x/deepseek-v4-flash',
        modelId: 'deepseek-v4-flash',
        nativeModel: 'deepseek-v4-flash',
      });

      expect(hostChatCalls).toBe(0);
      expect(stopReason).not.toBe('completed');
    },
  );

  it('falls back to the host proxy when the config still points at another model', async () => {
    const { hostChatCalls, stopReason } = await driveGuardTurn({
      alias: 'provider-x/deepseek-v4-flash',
      modelId: 'deepseek-v4-flash',
      nativeModel: 'other-model',
    });

    expect(hostChatCalls).toBeGreaterThan(0);
    expect(stopReason).toBe('completed');
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

// ── stdio transport: MultiLLM provider model routing ─────────────────────
// Guards the P16 seam fix on the stdio side: each racing provider's
// host/llm_chat must carry its own model_name into input.llm.chat.
describe.skipIf(!hasStdioCliBinary())('stdio transport — provider model routing', () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    const { shutdownRustEngine } = await import('./rust-loop');
    shutdownRustEngine();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('hands each concurrent provider’s model to the host chat', async () => {
    const mod = await import('./rust-loop');
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-stdio-models-'));
    tempDirs.push(workspace);
    mod.shutdownRustEngine();
    mod.forceEngineTransport('stdio');

    const providers = [
      { name: 'alpha', model: 'alpha-model', system_prompt: 'be brief' },
      { name: 'beta', model: 'beta-model', system_prompt: 'be brief' },
    ];
    const engine = mod.createRunTurnOverride(providers, workspace, {
      nativeTools: false,
      shellPath: undefined,
    });
    expect(engine).toBeDefined();

    const routed: string[] = [];
    const input = {
      turnId: 1,
      signal: new AbortController().signal,
      llm: {
        modelAlias: 'any',
        modelId: 'any',
        systemPrompt: 'test',
        async chat(inputArg: { modelName?: string }) {
          routed.push(inputArg.modelName ?? '');
          const name = (inputArg.modelName ?? '').toLowerCase();
          if (name === 'alpha-model') {
            return { toolCalls: [], providerFinishReason: 'stop', usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } };
          }
          if (name === 'beta-model') {
            return { toolCalls: [], providerFinishReason: 'stop', usage: { inputOther: 1, output: 1, inputCacheRead: 0, inputCacheCreation: 0 } };
          }
          throw new Error(`unroutable model: ${inputArg.modelName}`);
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
        return { output: '', isError: true };
      },
      async checkToolPermission() {
        return { decision: 'allow' as const };
      },
    };

    const result = await (engine as (i: unknown) => Promise<{ stopReason: string; steps: number }>)(input);

    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBeGreaterThanOrEqual(1);
    expect(new Set(routed)).toEqual(new Set(['alpha-model', 'beta-model']));
  });
});

// ── stdio transport: host/ask_question JS-side handler ────────────────────
// The Rust engine sends host/ask_question only once its native
// AskUserQuestion tool lands; these tests exercise the JS-side dispatch
// directly with a fake process so the seam is covered regardless of the
// binary's Rust version.

describe('stdio transport — host/ask_question JS handler', () => {
  type HostRequestHandler = {
    handleHostRequest(msg: { method?: string; id?: unknown; params?: unknown }): Promise<void>;
  };

  function fakeProcess(): {
    agent: AgentProcess;
    written: string[];
  } {
    const agent = new AgentProcess();
    const written: string[] = [];
    (agent as unknown as { process: { stdin: { write(line: string): void } } }).process = {
      stdin: { write: (line) => written.push(line) },
    };
    return { agent, written };
  }

  const questionParams = {
    question_id: 'question_1',
    turn_id: '1',
    tool_call_id: 'call-q',
    background: false,
    timeout_ms: null,
    questions: [
      {
        question: 'Which database?',
        header: 'Storage',
        options: [
          { label: 'Postgres', description: 'Relational storage' },
          { label: 'SQLite', description: 'Embedded storage' },
        ],
        multi_select: false,
      },
    ],
  };

  it('dispatches host/ask_question to the registered handler and writes the result', async () => {
    const { agent, written } = fakeProcess();
    const requests: unknown[] = [];
    agent.setAskQuestionHandler(async (request) => {
      requests.push(request);
      return { answers: { 'Which database?': 'Postgres' }, method: 'enter' };
    });
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 7,
      method: 'host/ask_question',
      params: questionParams,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ question_id: 'question_1', turn_id: '1' });
    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 7,
      result: { answers: { 'Which database?': 'Postgres' }, method: 'enter' },
    });
  });

  it('answers an unwired host/ask_question with the unsupported error', async () => {
    const { agent, written } = fakeProcess();
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 8,
      method: 'host/ask_question',
      params: questionParams,
    });

    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 8,
      error: { code: -32603, message: 'host does not support interactive questions' },
    });
  });

  it('propagates a handler failure as a JSON-RPC error', async () => {
    const { agent, written } = fakeProcess();
    agent.setAskQuestionHandler(async () => {
      throw new Error('question service exploded');
    });
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 9,
      method: 'host/ask_question',
      params: questionParams,
    });

    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32603, message: 'question service exploded' },
    });
  });
});

// ── stdio transport: host/ask_question end to end ─────────────────────────
// A real stdio engine process drives the AskUserQuestion tool natively: the
// engine emits host/ask_question, the JS handler answers, and the answer
// becomes the tool result the next host/llm_chat request sees.

describe.skipIf(!hasStdioCliBinary())('stdio transport — host/ask_question end to end', () => {
  const tempDirs: string[] = [];

  // Same contract alias as the check_permission block above: the v2
  // TurnEngineInput shape, imported type-only to keep this file free of a
  // build-time dependency on the workspace package.
  type TurnEngineInputLike = Parameters<Awaited<ReturnType<typeof import('./rust-loop').createRunTurnOverride>> extends infer E ? E extends (...args: infer A) => unknown ? (...args: A) => unknown : never : never>[0];

  afterEach(async () => {
    const { shutdownRustEngine } = await import('./rust-loop');
    shutdownRustEngine();
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  const questionArgs = {
    questions: [
      {
        question: 'Which database?',
        header: 'Storage',
        options: [
          { label: 'Postgres', description: 'Relational storage' },
          { label: 'SQLite', description: 'Embedded storage' },
        ],
        multi_select: false,
      },
    ],
    turn_id: '1',
    tool_call_id: 'call-q',
    background: false,
  };

  async function driveAskQuestionTurn(opts: {
    askUserQuestion?: (request: AskQuestionWire) => Promise<AskQuestionWireResult>;
  }): Promise<{
    hostRequests: Array<{ method?: string; params?: unknown }>;
    writtenToEngine: string[];
    chatMessages: unknown[][];
    toolResultEvents: Array<{ output?: unknown; isError?: boolean }>;
    result: unknown;
  }> {
    const mod = await import('./rust-loop');
    const workspace = mkdtempSync(join(tmpdir(), 'kimi-rust-stdio-ask-'));
    tempDirs.push(workspace);
    mod.shutdownRustEngine();
    mod.forceEngineTransport('stdio');

    const engine = mod.createRunTurnOverride(undefined, workspace, {
      nativeTools: true,
      shellPath: undefined,
    });
    expect(engine).toBeDefined();

    // Spy on the live stdio process: record every host request the engine
    // sends and every response line written back to it. The engine only
    // starts talking after agent/run_turn, so the spies are installed
    // before the turn begins.
    const agent = mod.activeAgentProcessForTests() as unknown as {
      handleHostRequest?: (msg: { method?: string; params?: unknown }) => Promise<void>;
      process?: { stdin?: { write(line: string): unknown } };
    } | null;
    const hostRequests: Array<{ method?: string; params?: unknown }> = [];
    const writtenToEngine: string[] = [];
    const originalHandleHostRequest = agent?.handleHostRequest;
    if (agent && originalHandleHostRequest) {
      agent.handleHostRequest = async (msg) => {
        hostRequests.push(msg);
        await originalHandleHostRequest.call(agent, msg);
      };
    }
    const stdin = agent?.process?.stdin;
    if (stdin) {
      const originalWrite = stdin.write.bind(stdin);
      stdin.write = (line: string) => {
        writtenToEngine.push(line);
        return originalWrite(line);
      };
    }

    const chatMessages: unknown[][] = [];
    const toolResultEvents: Array<{ output?: unknown; isError?: boolean }> = [];
    let chatCallCount = 0;

    const input = {
      turnId: 1,
      signal: new AbortController().signal,
      llm: {
        modelAlias: 'test-model',
        modelId: 'test-model',
        systemPrompt: 'You are a test driver.',
        async chat(inputArg: { messages: unknown[] }) {
          chatMessages.push(inputArg.messages);
          const call = chatCallCount++;
          if (call === 0) {
            return {
              toolCalls: [
                {
                  type: 'function',
                  id: 'call-q',
                  name: 'ask_user_question',
                  arguments: JSON.stringify(questionArgs),
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
        // Mirror the host transcript: the tool.result events the adapter
        // dispatched for the native tool become the tool messages the next
        // llm request sees.
        return toolResultEvents.map((tr) => ({
          role: 'tool',
          content: [
            {
              type: 'text',
              text: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output),
            },
          ],
          toolCallId: 'call-q',
        }));
      },
      buildTools() {
        return [];
      },
      async dispatchEvent(event: unknown) {
        const e = event as { type?: string; result?: { output?: unknown; isError?: boolean } };
        if (e.type === 'tool.result' && e.result) {
          toolResultEvents.push({ output: e.result.output, isError: e.result.isError });
        }
      },
      async executeTool() {
        return { output: 'UNREACHABLE host fallback', isError: true };
      },
      async checkToolPermission() {
        return { decision: 'allow' as const };
      },
      askUserQuestion: opts.askUserQuestion,
    } satisfies TurnEngineInputLike;

    const result = await (engine as (i: TurnEngineInputLike) => Promise<unknown>)(input);
    return { hostRequests, writtenToEngine, chatMessages, toolResultEvents, result };
  }

  it('round-trips an answered question through the real stdio engine', async () => {
    const received: unknown[] = [];
    const out = await driveAskQuestionTurn({
      askUserQuestion: async (request) => {
        received.push(request);
        return { answers: { 'Which database?': 'Postgres' }, method: 'enter' };
      },
    });

    // The engine must emit host/ask_question with the wire method and the
    // engine-generated question id plus the parsed questions.
    const askRequests = out.hostRequests.filter((r) => r.method === 'host/ask_question');
    expect(askRequests).toHaveLength(1);
    const params = askRequests[0]?.params as {
      question_id?: string;
      questions?: Array<{ question?: string }>;
    };
    expect(params?.question_id).toMatch(/^question_[0-9a-f]{16}$/);
    expect(params?.questions).toHaveLength(1);
    expect(params?.questions?.[0]?.question).toBe('Which database?');

    // The JS handler received the same request the engine sent.
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      turn_id: '1',
      tool_call_id: 'call-q',
      background: false,
      timeout_ms: null,
    });

    // The answer became the native tool result the next llm request sees.
    expect(out.toolResultEvents).toHaveLength(1);
    expect(out.toolResultEvents[0]).toEqual({
      output: '{"answers":{"Which database?":"Postgres"}}',
      isError: false,
    });
    const secondChat = out.chatMessages[1];
    expect(secondChat).toHaveLength(1);
    expect(secondChat?.[0]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: '{"answers":{"Which database?":"Postgres"}}' }],
    });
    expect((out.result as { stopReason: string }).stopReason).toBe('completed');
  });

  it('reports an unwired host as an unsupported error the model must not retry', async () => {
    const out = await driveAskQuestionTurn({});

    // The engine received a JSON-RPC error (-32603) on the wire.
    const errorLines = out.writtenToEngine
      .map((line) => JSON.parse(line) as { error?: { code?: number } })
      .filter((m) => m.error !== undefined);
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]?.error?.code).toBe(-32603);

    // The tool result carries the v2 unsupported message; the model must
    // not retry the tool.
    expect(out.toolResultEvents).toHaveLength(1);
    expect(out.toolResultEvents[0]?.isError).toBe(true);
    expect(String(out.toolResultEvents[0]?.output)).toContain('Do NOT call this tool again');
    const secondChat = out.chatMessages[1];
    expect(secondChat?.[0]).toMatchObject({
      role: 'tool',
      content: [{ type: 'text', text: expect.stringContaining('Do NOT call this tool again') }],
    });
  });
});

// ── napi adapter layer: ask_question callback passing ─────────────────────
// The native addon invokes the 8th runTurnRust callback only once the Rust
// side lands; these tests verify the JS adapter passes it through with a
// fake native module.

describe('NapiEngine — ask_question callback passing', () => {
  function fakeEngine(): {
    engine: NapiEngine;
    received: unknown[][];
  } {
    const engine = new NapiEngine();
    const received: unknown[][] = [];
    (engine as unknown as { nativeModule: unknown }).nativeModule = {
      getCallbackPayload: () => null,
      resolveCallback: () => {},
      cancelTurn: () => {},
      runTurnRust: (...args: unknown[]) => {
        received.push(args);
        return Promise.resolve({
          stopReason: 'EndTurn',
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          llmTransport: 'host-proxy',
          nativeToolCalls: 0,
        });
      },
    };
    return { engine, received };
  }

  const emptyTurnParams = {
    turnId: '1',
    systemPrompt: 'test',
    modelName: 'test-model',
    messages: [],
    tools: [],
  };

  it('passes askQuestionCb as the 8th runTurnRust argument and round-trips through the registry', async () => {
    const engine = new NapiEngine();
    const received: unknown[][] = [];
    const payloads = new Map<number, string>();
    let resolved: { id: number; error: string | null; result: string | null } | undefined;
    (engine as unknown as { nativeModule: unknown }).nativeModule = {
      getCallbackPayload: (id: number) => payloads.get(id) ?? null,
      resolveCallback: (id: number, error: string | null, result: string | null) => {
        resolved = { id, error, result };
      },
      cancelTurn: () => {},
      runTurnRust: (...args: unknown[]) => {
        received.push(args);
        return Promise.resolve({
          stopReason: 'EndTurn',
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          llmTransport: 'host-proxy',
          nativeToolCalls: 0,
        });
      },
    };
    const askQuestionCb = async (request: { question_id: string }) => ({
      answers: { 'Which database?': request.question_id },
    });
    await engine.runTurn(
      emptyTurnParams,
      async () => JSON.stringify({ tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
      async () => JSON.stringify({ content: '', is_error: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      askQuestionCb,
    );

    expect(received).toHaveLength(1);
    const askQuestionHandler = received[0]?.[7];
    expect(typeof askQuestionHandler).toBe('function');
    payloads.set(42, JSON.stringify({ question_id: 'question_1' }));
    (askQuestionHandler as (callbackId: number) => void)(42);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved).toEqual({
      id: 42,
      error: null,
      result: JSON.stringify({ answers: { 'Which database?': 'question_1' } }),
    });
  });

  it('leaves the 8th runTurnRust argument undefined without askQuestionCb', async () => {
    const { engine, received } = fakeEngine();
    await engine.runTurn(
      emptyTurnParams,
      async () => JSON.stringify({ tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
      async () => JSON.stringify({ content: '', is_error: false }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.[7]).toBeUndefined();
  });
});

// ── stdio transport: host/state_read / host/state_write JS handlers ────────
// The Rust engine sends the state bridge methods only once its native
// TodoList / EnterPlanMode tools land; these tests exercise the JS-side
// dispatch directly with a fake process so the seam is covered regardless of
// the binary's Rust version.

describe('stdio transport — host/state_read / host/state_write JS handlers', () => {
  type HostRequestHandler = {
    handleHostRequest(msg: { method?: string; id?: unknown; params?: unknown }): Promise<void>;
  };

  function fakeProcess(): {
    agent: AgentProcess;
    written: string[];
  } {
    const agent = new AgentProcess();
    const written: string[] = [];
    (agent as unknown as { process: { stdin: { write(line: string): void } } }).process = {
      stdin: { write: (line) => written.push(line) },
    };
    return { agent, written };
  }

  const readParams = { domain: 'todo', key: 'todo', turn_id: '1', tool_call_id: 'call-r' };
  const writeParams = {
    domain: 'todo',
    key: 'todo',
    value: [{ title: 'Read session-control.ts', status: 'in_progress' }],
    undoable: true,
    turn_id: '1',
    tool_call_id: 'call-w',
  };

  it('dispatches host/state_read to the registered handler and writes the result', async () => {
    const { agent, written } = fakeProcess();
    const requests: unknown[] = [];
    agent.setStateReadHandler(async (request) => {
      requests.push(request);
      return {
        value: [{ id: 'T1', parentId: null, kind: 'task', title: 'x', status: 'pending' }],
      };
    });
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 10,
      method: 'host/state_read',
      params: readParams,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ domain: 'todo', key: 'todo', turn_id: '1' });
    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 10,
      result: {
        value: [{ id: 'T1', parentId: null, kind: 'task', title: 'x', status: 'pending' }],
      },
    });
  });

  it('dispatches host/state_write to the registered handler and writes the result', async () => {
    const { agent, written } = fakeProcess();
    const requests: unknown[] = [];
    agent.setStateWriteHandler(async (request) => {
      requests.push(request);
      return {
        ok: true,
        value: [
          { id: 'T1', parentId: null, kind: 'task', title: 'x', status: 'in_progress' },
        ],
      };
    });
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 11,
      method: 'host/state_write',
      params: writeParams,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ domain: 'todo', key: 'todo', undoable: true });
    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 11,
      result: {
        ok: true,
        value: [{ id: 'T1', parentId: null, kind: 'task', title: 'x', status: 'in_progress' }],
      },
    });
  });

  it('answers an unwired host/state_read with the unsupported error', async () => {
    const { agent, written } = fakeProcess();
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 12,
      method: 'host/state_read',
      params: readParams,
    });

    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 12,
      error: { code: -32603, message: 'host does not support state bridge' },
    });
  });

  it('answers an unwired host/state_write with the unsupported error', async () => {
    const { agent, written } = fakeProcess();
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 13,
      method: 'host/state_write',
      params: writeParams,
    });

    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 13,
      error: { code: -32603, message: 'host does not support state bridge' },
    });
  });

  it('propagates a handler failure with its JSON-RPC error code', async () => {
    const { agent, written } = fakeProcess();
    agent.setStateReadHandler(async () => {
      const error = new Error('unknown state domain: goal');
      (error as { code?: number }).code = -32001;
      throw error;
    });
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 14,
      method: 'host/state_read',
      params: readParams,
    });

    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 14,
      error: { code: -32001, message: 'unknown state domain: goal' },
    });
  });

  it('propagates a handler failure without a code as -32603', async () => {
    const { agent, written } = fakeProcess();
    agent.setStateWriteHandler(async () => {
      throw new Error('state service exploded');
    });
    await (agent as unknown as HostRequestHandler).handleHostRequest({
      jsonrpc: '2.0',
      id: 15,
      method: 'host/state_write',
      params: writeParams,
    });

    expect(JSON.parse(written[0] ?? '')).toEqual({
      jsonrpc: '2.0',
      id: 15,
      error: { code: -32603, message: 'state service exploded' },
    });
  });
});

// ── napi adapter layer: state bridge callback passing ─────────────────────
// The native addon invokes the 9th/10th runTurnRust callbacks only once the
// Rust side lands; these tests verify the JS adapter passes them through
// with a fake native module.

describe('NapiEngine — state bridge callback passing', () => {
  function fakeEngine(): {
    engine: NapiEngine;
    received: unknown[][];
  } {
    const engine = new NapiEngine();
    const received: unknown[][] = [];
    (engine as unknown as { nativeModule: unknown }).nativeModule = {
      getCallbackPayload: () => null,
      resolveCallback: () => {},
      cancelTurn: () => {},
      runTurnRust: (...args: unknown[]) => {
        received.push(args);
        return Promise.resolve({
          stopReason: 'EndTurn',
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          llmTransport: 'host-proxy',
          nativeToolCalls: 0,
        });
      },
    };
    return { engine, received };
  }

  const emptyTurnParams = {
    turnId: '1',
    systemPrompt: 'test',
    modelName: 'test-model',
    messages: [],
    tools: [],
  };

  it('passes stateReadCb and stateWriteCb as the 9th and 10th runTurnRust arguments and round-trips through the registry', async () => {
    const engine = new NapiEngine();
    const received: unknown[][] = [];
    const payloads = new Map<number, string>();
    const resolved: Array<{ id: number; error: string | null; result: string | null }> = [];
    (engine as unknown as { nativeModule: unknown }).nativeModule = {
      getCallbackPayload: (id: number) => payloads.get(id) ?? null,
      resolveCallback: (id: number, error: string | null, result: string | null) => {
        resolved.push({ id, error, result });
      },
      cancelTurn: () => {},
      runTurnRust: (...args: unknown[]) => {
        received.push(args);
        return Promise.resolve({
          stopReason: 'EndTurn',
          steps: 1,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          inputCacheRead: 0,
          inputCacheCreation: 0,
          llmTransport: 'host-proxy',
          nativeToolCalls: 0,
        });
      },
    };
    const stateReadCb = async (request: { domain: string }) => ({
      value: { domain: request.domain },
    });
    const stateWriteCb = async (request: { domain: string; value: unknown }) => ({
      ok: true,
      value: request.value,
    });
    await engine.runTurn(
      emptyTurnParams,
      async () => JSON.stringify({ tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
      async () => JSON.stringify({ content: '', is_error: false }),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      stateReadCb,
      stateWriteCb,
    );

    expect(received).toHaveLength(1);
    const stateReadHandler = received[0]?.[8];
    const stateWriteHandler = received[0]?.[9];
    expect(typeof stateReadHandler).toBe('function');
    expect(typeof stateWriteHandler).toBe('function');
    payloads.set(42, JSON.stringify({ domain: 'todo', key: 'todo' }));
    (stateReadHandler as (callbackId: number) => void)(42);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved[0]).toEqual({
      id: 42,
      error: null,
      result: JSON.stringify({ value: { domain: 'todo' } }),
    });
    payloads.set(43, JSON.stringify({ domain: 'todo', key: 'todo', value: [], undoable: true }));
    (stateWriteHandler as (callbackId: number) => void)(43);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(resolved[1]).toEqual({
      id: 43,
      error: null,
      result: JSON.stringify({ ok: true, value: [] }),
    });
  });

  it('leaves the 9th and 10th runTurnRust arguments undefined without the callbacks', async () => {
    const { engine, received } = fakeEngine();
    await engine.runTurn(
      emptyTurnParams,
      async () => JSON.stringify({ tool_calls: [], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }),
      async () => JSON.stringify({ content: '', is_error: false }),
    );

    expect(received).toHaveLength(1);
    expect(received[0]?.[8]).toBeUndefined();
    expect(received[0]?.[9]).toBeUndefined();
  });
});

describe('wire-schema', () => {
  it('accepts a canonical stdio run_turn request', () => {
    const parsed = runTurnParamsSchema.safeParse({
      turn_id: 'turn-1',
      system_prompt: 'sp',
      model_name: 'm',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: 'c1', name: 'Read', arguments: { path: 'a' } }],
        },
        { role: 'tool', content: 'out', tool_call_id: 'c1' },
      ],
      tools: [{ name: 'read', description: 'd', input_schema: { type: 'object' } }],
      max_steps: 3,
      providers: [],
      goal: {
        goal_id: 'g1',
        objective: 'obj',
        status: 'active',
        wall_clock_ms: 0,
        tokens_used: 0,
        turns_used: 0,
      },
      native_tools: true,
      rust_self_contained: false,
      policy_snapshot: { mode: 'manual', deny_rules: ['Write(*)'] },
      github_token: 'tok',
    });
    expect(parsed.success).toBe(true);
  });

  it('rejects a mistyped run_turn request field', () => {
    const parsed = runTurnParamsSchema.safeParse({
      turn_id: 'turn-1',
      system_prompt: 'sp',
      model_name: 'm',
      messages: [],
      tools: [],
      max_steps: '3',
    });
    expect(parsed.success).toBe(false);
  });

  it('accepts a minimal run_turn result and rejects a missing stop_reason', () => {
    expect(
      runTurnResultSchema.safeParse({
        stop_reason: 'EndTurn',
        steps: 1,
        usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      }).success,
    ).toBe(true);
    expect(
      runTurnResultSchema.safeParse({ steps: 1, usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } })
        .success,
    ).toBe(false);
  });
});

// ── host/turn_event (engine turn lifecycle) ────────────────────────────────
// From M1b on the engine assigns turn ids and reports them over this channel.
// The durable records drive the host append log, so a payload that does not
// match the wire mirror must be reported rather than dropped in silence.

describe('host/turn_event transport', () => {
  it('dispatches a durable turn event to the registered handler', () => {
    const agent = new AgentProcess();
    const seen: unknown[] = [];
    agent.setTurnEventHandler((event) => seen.push(event));
    const target = agent as unknown as { buffer: string; processBuffer(): void };
    // A trailing fragment is held back for the next read, so a line needs its terminator.
    const newline = String.fromCharCode(10);
    const feed = (message: unknown) => {
      target.buffer = JSON.stringify(message) + newline;
      target.processBuffer();
    };

    feed({
      jsonrpc: '2.0',
      method: 'host/turn_event',
      params: {
        type: 'turn.prompt',
        turnId: 3,
        input: [{ type: 'text', text: 'hi' }],
        origin: { kind: 'user' },
      },
    });
    feed({
      jsonrpc: '2.0',
      method: 'host/turn_event',
      params: { type: 'turn.ended', turnId: 3, reason: 'completed', durationMs: 12 },
    });

    expect(seen).toEqual([
      {
        type: 'turn.prompt',
        turnId: 3,
        input: [{ type: 'text', text: 'hi' }],
        origin: { kind: 'user' },
      },
      { type: 'turn.ended', turnId: 3, reason: 'completed', durationMs: 12 },
    ]);
  });

  it('rejects a malformed turn event instead of handing it to the host', () => {
    const agent = new AgentProcess();
    const seen: unknown[] = [];
    agent.setTurnEventHandler((event) => seen.push(event));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = agent as unknown as { buffer: string; processBuffer(): void };
    target.buffer =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'host/turn_event',
        params: { type: 'turn.ended', turnId: 3, reason: 'exploded' },
      }) + String.fromCharCode(10);
    target.processBuffer();

    expect(seen).toEqual([]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });

  it('accepts every event shape the engine emits', () => {
    for (const params of [
      { type: 'turn.prompt', turnId: 0, input: [], origin: { kind: 'user' } },
      { type: 'turn.started', turnId: 0, origin: { kind: 'user' } },
      { type: 'turn.cancel', turnId: 1, target: 'queued', reason: 'user_cancelled' },
      { type: 'turn.ended', turnId: 2, reason: 'blocked', durationMs: 5 },
    ]) {
      expect(turnEventSchema.safeParse(params).success, JSON.stringify(params)).toBe(true);
    }
  });

  it('rejects a drifted payload: a snake_case id or an unknown end reason', () => {
    expect(
      turnEventSchema.safeParse({ type: 'turn.ended', turn_id: 2, reason: 'completed' }).success,
    ).toBe(false);
    expect(
      turnEventSchema.safeParse({ type: 'turn.ended', turnId: 2, reason: 'nope' }).success,
    ).toBe(false);
  });
});

// ── host/telemetry (engine turn telemetry, M1c) ────────────────────────────
// The engine emits turn_started / turn_ended / turn_interrupted when the host
// injects a telemetry context; the host forwards one track2 per event. A
// payload that does not match the wire mirror must be reported rather than
// dropped in silence — a shape drift here is a dashboard drift.

describe('host/telemetry wire schema', () => {
  it('accepts every event shape the engine emits', () => {
    for (const params of [
      {
        event: 'turn_started',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
      },
      {
        event: 'turn_started',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        thinking_effort: 'high',
      },
      {
        event: 'turn_ended',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        reason: 'completed',
        duration_ms: 12,
        steps: 2,
      },
      {
        event: 'turn_ended',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        reason: 'failed',
        duration_ms: 3,
      },
      {
        event: 'turn_interrupted',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        at_step: 1,
        interrupt_reason: 'aborted',
      },
      {
        event: 'turn_interrupted',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        interrupt_reason: 'error',
      },
    ]) {
      expect(telemetryEventSchema.safeParse(params).success, JSON.stringify(params)).toBe(true);
    }
  });

  it('rejects drifted payloads: camelCase id, unknown reason, unknown interrupt reason', () => {
    expect(
      telemetryEventSchema.safeParse({
        event: 'turn_started',
        turnId: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
      }).success,
    ).toBe(false);
    expect(
      telemetryEventSchema.safeParse({
        event: 'turn_ended',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        reason: 'exploded',
        duration_ms: 1,
      }).success,
    ).toBe(false);
    expect(
      telemetryEventSchema.safeParse({
        event: 'turn_interrupted',
        turn_id: 't1',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        interrupt_reason: 'meh',
      }).success,
    ).toBe(false);
  });
});

describe('host/telemetry transport', () => {
  it('dispatches a telemetry event to the registered handler', () => {
    const agent = new AgentProcess();
    const seen: unknown[] = [];
    agent.setTelemetryHandler((event) => seen.push(event));
    const target = agent as unknown as { buffer: string; processBuffer(): void };
    // A trailing fragment is held back for the next read, so a line needs its terminator.
    const newline = String.fromCharCode(10);
    const feed = (message: unknown) => {
      target.buffer = JSON.stringify(message) + newline;
      target.processBuffer();
    };

    feed({
      jsonrpc: '2.0',
      method: 'host/telemetry',
      params: {
        event: 'turn_started',
        turn_id: 'turn-9',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        thinking_effort: 'high',
      },
    });
    feed({
      jsonrpc: '2.0',
      method: 'host/telemetry',
      params: {
        event: 'turn_ended',
        turn_id: 'turn-9',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        reason: 'completed',
        duration_ms: 42,
        steps: 2,
      },
    });

    expect(seen).toEqual([
      {
        event: 'turn_started',
        turn_id: 'turn-9',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        thinking_effort: 'high',
      },
      {
        event: 'turn_ended',
        turn_id: 'turn-9',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        reason: 'completed',
        duration_ms: 42,
        steps: 2,
      },
    ]);
  });

  it('rejects a malformed telemetry event instead of handing it to the host', () => {
    const agent = new AgentProcess();
    const seen: unknown[] = [];
    agent.setTelemetryHandler((event) => seen.push(event));
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const target = agent as unknown as { buffer: string; processBuffer(): void };
    target.buffer =
      JSON.stringify({
        jsonrpc: '2.0',
        method: 'host/telemetry',
        params: {
          event: 'turn_ended',
          turn_id: 'turn-9',
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          reason: 'exploded',
          duration_ms: 1,
        },
      }) + String.fromCharCode(10);
    target.processBuffer();

    expect(seen).toEqual([]);
    expect(errors).toHaveBeenCalledOnce();
    errors.mockRestore();
  });
});

describe.skipIf(!napiEntry)('createRunTurnOverride — napi turn telemetry (M1c)', () => {
  beforeEach(async () => {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
  });

  afterEach(async () => {
    const mod = await import('./rust-loop');
    mod.shutdownRustEngine();
  });

  it(
    'emits turn_started / turn_ended with the host context merged in',
    { timeout: 15_000 },
    async () => {
      const mod = await import('./rust-loop');
      mod.forceEngineTransport('napi');

      const seen: unknown[] = [];
      const engine = mod.createRunTurnOverride(undefined, undefined, {
        getTelemetryContext: () => ({
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'high',
        }),
        onTelemetry: (event) => seen.push(event),
      });
      expect(engine).toBeDefined();

      const input = {
        turnId: 7,
        signal: new AbortController().signal,
        llm: {
          modelAlias: 'test-model',
          modelId: 'test-model',
          systemPrompt: 'test',
          async chat() {
            return {
              toolCalls: [],
              providerFinishReason: 'stop',
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

      const result = (await (engine as (i: typeof input) => Promise<unknown>)(input)) as {
        stopReason: string;
      };
      expect(result.stopReason).toBe('completed');

      expect(seen.length).toBe(2);
      expect(seen[0]).toMatchObject({
        event: 'turn_started',
        turn_id: '7',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        thinking_effort: 'high',
      });
      expect(seen[1]).toMatchObject({
        event: 'turn_ended',
        turn_id: '7',
        mode: 'agent',
        provider_type: 'kimi',
        protocol: 'openai',
        thinking_effort: 'high',
        reason: 'completed',
        steps: 1,
      });
      expect(typeof (seen[1] as { duration_ms: number }).duration_ms).toBe('number');
    },
  );
});

// ── host/list_tools (engine tool-table refresh, M1d) ───────────────────────
// The engine pulls the fresh tool table before each native LLM call; the
// turn-start snapshot is only the fallback. The stdio dispatch must answer
// with the handler's table and must not hand the engine a silent default.

describe('host/list_tools transport', () => {
  it('answers the engine with the registered handler’s tool table', async () => {
    const agent = new AgentProcess();
    let calls = 0;
    agent.setListToolsHandler(async () => {
      calls += 1;
      return {
        tools: [{ name: 'fresh_tool', description: 'fresh', input_schema: { type: 'object' } }],
      };
    });
    const written: string[] = [];
    const target = agent as unknown as {
      buffer: string;
      processBuffer(): void;
      writeHostResult(id: unknown, result: unknown): void;
    };
    const originalWrite = target.writeHostResult.bind(target);
    target.writeHostResult = (id, result) => {
      written.push(JSON.stringify(result));
      originalWrite(id, result);
    };
    target.buffer =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 11,
        method: 'host/list_tools',
        params: {},
      }) + String.fromCharCode(10);
    target.processBuffer();
    // The handler is async: the response lands on a later microtask.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(calls).toBe(1);
    expect(written).toEqual([
      JSON.stringify({
        tools: [{ name: 'fresh_tool', description: 'fresh', input_schema: { type: 'object' } }],
      }),
    ]);
  });

  it('errors an unwired list_tools request so the engine falls back to the snapshot', () => {
    const agent = new AgentProcess();
    const errors: string[] = [];
    const target = agent as unknown as {
      buffer: string;
      processBuffer(): void;
      writeHostError(id: unknown, message: string): void;
    };
    const originalWrite = target.writeHostError.bind(target);
    target.writeHostError = (id, message) => {
      errors.push(message);
      originalWrite(id, message);
    };
    target.buffer =
      JSON.stringify({
        jsonrpc: '2.0',
        id: 12,
        method: 'host/list_tools',
        params: {},
      }) + String.fromCharCode(10);
    target.processBuffer();

    expect(errors).toEqual(['host does not support list_tools']);
  });
});
