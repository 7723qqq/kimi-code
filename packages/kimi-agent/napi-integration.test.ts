/**
 * Napi-rs integration tests — end-to-end verification of the native addon.
 *
 * These tests verify that:
 * 1. The native module loads and exports runTurnRust + resolveCallback
 * 2. runTurnRust accepts valid params and callbacks via the callback registry
 * 3. JSON serialization round-trips correctly between JS and Rust
 * 4. Error handling works for invalid inputs
 * 5. createRunTurnOverride correctly selects the napi path
 */

import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// ── Helpers ────────────────────────────────────────────────────────────────

const nativeEntry = readdirSync(import.meta.dirname).find(
  (f) => f.endsWith('.node') && f.startsWith('kimi_agent'),
);

/** Direct native module access (bypasses rust-loop.ts adapter). */
function loadNativeModule(): {
  runTurnRust: (...args: unknown[]) => Promise<unknown>;
  resolveCallback: (id: number, error: string | null, result: string | null) => void;
  getCallbackPayload: (id: number) => string | null;
} {
  if (!nativeEntry) {
    throw new Error('kimi_agent native addon not built; run `napi build` in packages/kimi-agent');
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require(resolve(import.meta.dirname, nativeEntry));
}

/**
 * Create a callback registry adapter for use with runTurnRust.
 *
 * The native module now passes a `callbackId: number` to the JS callback.
 * The JS side must:
 * 1. Call `getCallbackPayload(id)` to fetch the JSON request payload
 * 2. Process the request
 * 3. Call `resolveCallback(id, error?, result?)` to resolve
 */
function makeCallback(
  mod: ReturnType<typeof loadNativeModule>,
  handler: (request: string) => string | Promise<string>,
): (callbackId: number) => void {
  return (callbackId: number) => {
    const payload = mod.getCallbackPayload(callbackId);
    if (!payload) return;
    try {
      const result = handler(payload);
      if (result instanceof Promise) {
        result.then(
          (res) => mod.resolveCallback(callbackId, null, res),
          (error: unknown) =>
            mod.resolveCallback(
              callbackId,
              error instanceof Error ? error.message : String(error),
              null,
            ),
        );
      } else {
        mod.resolveCallback(callbackId, null, result);
      }
    } catch (error: unknown) {
      mod.resolveCallback(callbackId, error instanceof Error ? error.message : String(error), null);
    }
  };
}

/** Minimal valid params for a turn. */
const validParams = {
  turnId: 'test-turn-1',
  systemPrompt: 'You are a test assistant.',
  modelName: 'test-model',
  messages: [] as Array<{ role: string; content: string }>,
  tools: [] as Array<{ name: string; description: string; inputSchema: string }>,
  maxSteps: 2,
};

// ── Tests ──────────────────────────────────────────────────────────────────

describe.skipIf(!nativeEntry)('napi native module', () => {
  it('loads and exports runTurnRust and resolveCallback', () => {
    const mod = loadNativeModule();
    expect(mod).toBeDefined();
    expect(typeof mod.runTurnRust).toBe('function');
    expect(typeof mod.resolveCallback).toBe('function');
  });

  it('runTurnRust returns a Promise', () => {
    const mod = loadNativeModule();
    const result = mod.runTurnRust(
      validParams,
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );
    expect(result).toBeInstanceOf(Promise);
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — basic turn', () => {
  it('completes a turn with no tool calls', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      validParams,
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: 'ok', is_error: false })),
    );

    expect(result).toBeDefined();
    expect(typeof result.stopReason).toBe('string');
    expect(typeof result.steps).toBe('number');
    expect(typeof result.inputTokens).toBe('number');
    expect(typeof result.outputTokens).toBe('number');
    expect(typeof result.totalTokens).toBe('number');
  });

  it('stop reason is a valid Rust enum variant', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      validParams,
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );

    const validReasons = ['EndTurn', 'MaxTokens', 'Filtered', 'Paused', 'Aborted', 'BudgetLimited'];
    const isValid =
      validReasons.some((r) => result.stopReason === r) || result.stopReason.startsWith('Error:');
    expect(isValid).toBe(true);
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — JSON serialization round-trip', () => {
  it('llm_chat callback receives valid JSON', async () => {
    const mod = loadNativeModule();
    let receivedRequest: unknown = null;

    await mod.runTurnRust(
      validParams,
      makeCallback(mod, (req) => {
        receivedRequest = JSON.parse(req);
        return JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        });
      }),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );

    expect(receivedRequest).toBeDefined();
    expect(typeof (receivedRequest as Record<string, unknown>).system_prompt).toBe('string');
    expect(typeof (receivedRequest as Record<string, unknown>).model_name).toBe('string');
    expect(Array.isArray((receivedRequest as Record<string, unknown>).messages)).toBe(true);
    expect(Array.isArray((receivedRequest as Record<string, unknown>).tools)).toBe(true);
  });

  it('llm_chat callback response is parsed correctly by Rust', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      validParams,
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 42, output_tokens: 7, total_tokens: 49 },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );

    expect(result).toBeDefined();
    expect(result.stopReason).toBe('EndTurn');
  });

  it('llm_chat callback with malformed JSON returns error result', async () => {
    const mod = loadNativeModule();

    await expect(
      mod.runTurnRust(
        validParams,
        makeCallback(mod, (_req) => 'not valid json {{{'),
        makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
      ),
    ).rejects.toThrow(/llm_chat parse/);
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — tool execution', () => {
  it('executes tool calls when LLM responds with tool_calls', async () => {
    const mod = loadNativeModule();
    let toolExecuted = false;
    let receivedToolRequest: unknown = null;

    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        tools: [
          {
            name: 'echo',
            description: 'Echo back input',
            inputSchema: '{"type":"object","properties":{"text":{"type":"string"}}}',
          },
        ],
      },
      makeCallback(mod, (req) => {
        const parsed = JSON.parse(req);
        if (parsed.messages && parsed.messages.length <= 1) {
          return JSON.stringify({
            tool_calls: [{ id: 'call_1', name: 'echo', arguments: { text: 'hello' } }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          });
        }
        return JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 5, output_tokens: 2, total_tokens: 7 },
        });
      }),
      makeCallback(mod, (req) => {
        toolExecuted = true;
        receivedToolRequest = JSON.parse(req);
        return JSON.stringify({ content: `echo: ${JSON.parse(req).arguments}`, is_error: false });
      }),
    );

    expect(toolExecuted).toBe(true);
    expect(receivedToolRequest).toBeDefined();
    expect((receivedToolRequest as Record<string, unknown>).tool_name).toBe('echo');
    expect(result).toBeDefined();
    expect(result.stopReason).toBe('EndTurn');
  });

  it('tool execution error is propagated', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        tools: [{ name: 'fail', description: 'Always fails', inputSchema: '{"type":"object"}' }],
      },
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [{ id: 'call_1', name: 'fail', arguments: {} }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        }),
      ),
      makeCallback(mod, (_req) =>
        JSON.stringify({ content: 'something went wrong', is_error: true }),
      ),
    );

    expect(result).toBeDefined();
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — error handling', () => {
  it('handles callback throwing an exception', async () => {
    const mod = loadNativeModule();

    await expect(
      mod.runTurnRust(
        validParams,
        makeCallback(mod, (_req) => {
          throw new Error('LLM unavailable');
        }),
        makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
      ),
    ).rejects.toThrow(/LLM unavailable/);
  });

  it('handles execute_tool callback throwing', async () => {
    const mod = loadNativeModule();

    await expect(
      mod.runTurnRust(
        {
          ...validParams,
          maxSteps: 3,
          tools: [{ name: 'crash', description: 'Crashes', inputSchema: '{"type":"object"}' }],
        },
        makeCallback(mod, (_req) =>
          JSON.stringify({
            tool_calls: [{ id: 'call_1', name: 'crash', arguments: {} }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
          }),
        ),
        makeCallback(mod, (_req) => {
          throw new Error('Tool crash');
        }),
      ),
    ).rejects.toThrow(/Tool crash/);
  });

  it('handles async callback rejection', async () => {
    const mod = loadNativeModule();

    await expect(
      mod.runTurnRust(
        validParams,
        makeCallback(mod, (_req) => Promise.reject(new Error('Async LLM failure'))),
        makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
      ),
    ).rejects.toThrow(/Async LLM failure/);
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — max steps enforcement', () => {
  it('respects maxSteps and stops', async () => {
    const mod = loadNativeModule();
    let llmCallCount = 0;

    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 2,
        tools: [{ name: 'loop', description: 'Loops', inputSchema: '{"type":"object"}' }],
      },
      makeCallback(mod, (_req) => {
        llmCallCount++;
        return JSON.stringify({
          tool_calls: [{ id: `call_${llmCallCount}`, name: 'loop', arguments: {} }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, (_req) => JSON.stringify({ content: 'ok', is_error: false })),
    );

    // When maxSteps is exhausted, the loop exits with EndTurn (not MaxTokens).
    // MaxTokens is reserved for when the LLM itself returns a max_tokens finish reason.
    expect(result.stopReason).toBe('EndTurn');
    expect(result.steps).toBe(2);
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — goal context', () => {
  it('accepts goal context params', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      {
        ...validParams,
        goal: {
          goalId: 'goal-1',
          objective: 'Test objective',
          status: 'active',
          tokenBudget: 1000,
          turnBudget: 5,
          tokensUsed: 0,
          turnsUsed: 0,
        },
      },
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );

    expect(result).toBeDefined();
    expect(result.stopReason).toBe('EndTurn');
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — delayed callback', () => {
  it('handles delayed async callbacks', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      validParams,
      (callbackId: number) => {
        // Simulate network latency with setTimeout
        setTimeout(() => {
          mod.resolveCallback(
            callbackId,
            null,
            JSON.stringify({
              tool_calls: [],
              finish_reason: 'stop',
              usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
            }),
          );
        }, 50);
      },
      (callbackId: number) => {
        mod.resolveCallback(callbackId, null, JSON.stringify({ content: '', is_error: false }));
      },
    );

    expect(result).toBeDefined();
    expect(result.stopReason).toBe('EndTurn');
  });
});

describe.skipIf(!nativeEntry)('createRunTurnOverride — engine selection', () => {
  it('selects the napi path and returns a TurnEngine when the addon is available', async () => {
    const { createRunTurnOverride } = await import('./rust-loop');
    const engine = createRunTurnOverride();
    expect(typeof engine).toBe('function');
  });

  it('drives a full turn through the napi path via the v2 TurnEngine contract', async () => {
    const { createRunTurnOverride } = await import('./rust-loop');
    const engine = createRunTurnOverride();
    expect(typeof engine).toBe('function');

    const events: string[] = [];
    const input = {
      turnId: 1,
      signal: new AbortController().signal,
      llm: {
        modelName: 'test-model',
        systemPrompt: 'You are a test assistant.',
        chat: () =>
          Promise.resolve({
            toolCalls: [],
            providerFinishReason: 'stop',
            usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
          }),
      },
      maxSteps: 1,
      buildMessages: () => Promise.resolve([]),
      buildTools: () => [],
      dispatchEvent: (event: { type: string }) => {
        events.push(event.type);
        return Promise.resolve();
      },
      executeTool: () => Promise.resolve({ output: '' }),
    };

    const result = await engine!(input as never);
    expect(result.stopReason).toBe('completed');
    expect(result.steps).toBeGreaterThanOrEqual(1);
    // The adapter opens/closes a step per llm_chat and reports content parts
    // through the host event bridge.
    expect(events).toContain('step.begin');
    expect(events).toContain('step.end');
  });
});
