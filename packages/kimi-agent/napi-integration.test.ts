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
  cancelTurn: (turnId: string) => void;
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
          (res) => {
            mod.resolveCallback(callbackId, null, res);
          },
          (error: unknown) => {
            mod.resolveCallback(
              callbackId,
              error instanceof Error ? error.message : String(error),
              null,
            );
          },
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

  it('reports the serving transport, the native tool count, and cache usage', async () => {
    const mod = loadNativeModule();

    const result = (await mod.runTurnRust(
      validParams,
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: {
            input_tokens: 7,
            output_tokens: 3,
            total_tokens: 10,
            input_cache_read: 5,
            input_cache_creation: 2,
          },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    )) as Record<string, unknown>;

    // validParams sets neither nativeLlm nor providers, and no native toolset
    // is engaged, so the host proxy served every step.
    expect(result.llmTransport).toBe('host-proxy');
    expect(result.nativeToolCalls).toBe(0);
    // Regression guard: the hand-built napi result object once omitted these
    // two, so cache usage always reached JS as zero.
    expect(result.inputCacheRead).toBe(5);
    expect(result.inputCacheCreation).toBe(2);
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

  it('surfaces an execute_tool callback throw to the model as an error result', async () => {
    const mod = loadNativeModule();
    const llmRequests: string[] = [];

    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 2,
        tools: [{ name: 'crash', description: 'Crashes', inputSchema: '{"type":"object"}' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(req);
        return JSON.stringify({
          tool_calls: [{ id: 'call_1', name: 'crash', arguments: {} }],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
        });
      }),
      makeCallback(mod, (_req) => {
        throw new Error('Tool crash');
      }),
    );

    // A failing tool call must not abort the turn: the round survives as an
    // error result the model sees on its next request.
    expect(result).toMatchObject({ steps: 2 });
    expect(llmRequests.length).toBe(2);
    expect(llmRequests[1]).toContain('Tool crash');
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

  it('runs past 10 steps when maxSteps is omitted (unbounded, JS-loop semantics)', async () => {
    const mod = loadNativeModule();
    let llmCallCount = 0;

    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: undefined,
        tools: [{ name: 'loop', description: 'Loops', inputSchema: '{"type":"object"}' }],
      },
      makeCallback(mod, (_req) => {
        llmCallCount++;
        if (llmCallCount <= 11) {
          return JSON.stringify({
            tool_calls: [{ id: `call_${llmCallCount}`, name: 'loop', arguments: {} }],
            finish_reason: 'tool_calls',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        }
        return JSON.stringify({
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, (_req) => JSON.stringify({ content: 'ok', is_error: false })),
    );

    expect(llmCallCount).toBe(12);
    expect(result.steps).toBe(12);
    expect(result.stopReason).toBe('EndTurn');
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — goal context', () => {
  it('accepts goal context params including wall-clock budget', async () => {
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
          wallClockBudgetMs: 60000,
          wallClockMs: 5000,
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

  it('stops with a BudgetLimited stop reason when the goal budget is exhausted', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      {
        ...validParams,
        goal: {
          goalId: 'goal-2',
          objective: 'Test objective',
          status: 'active',
          tokenBudget: 10,
          tokensUsed: 10,
          turnsUsed: 0,
          wallClockMs: 0,
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

    expect(result.stopReason).toBe('BudgetLimited');
    expect(result.steps).toBe(0);
  });

  it('reports telemetry counters on the turn result', async () => {
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
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );

    expect(result).toBeDefined();
    expect(typeof result.eventsEmitted).toBe('number');
    expect(typeof result.llmRetries).toBe('number');
    expect(result.eventsEmitted).toBeGreaterThanOrEqual(0);
    expect(result.llmRetries).toBeGreaterThanOrEqual(0);
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

describe.skipIf(!nativeEntry)('napi runTurnRust — cancellation', () => {
  it('aborts a running turn at the next step boundary (cancelTurn sets the flag)', async () => {
    const mod = loadNativeModule();

    // Gate the first llm_chat response behind a manual release so we can
    // guarantee the cancel flag is set before step 1 starts.
    let releaseFirstChat!: () => void;
    const firstChatGate = new Promise<void>((r) => {
      releaseFirstChat = r;
    });
    let chatCallCount = 0;
    const llmCb = (callbackId: number) => {
      const call = chatCallCount++;
      if (call === 0) {
        firstChatGate.then(
          () => {
            mod.resolveCallback(
              callbackId,
              null,
              JSON.stringify({
                tool_calls: [
                  { id: 'tc-cancel', name: 'Read', arguments: '{"path":"a.txt"}' },
                ],
                finish_reason: 'tool_calls',
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              }),
            );
          },
          () => {},
        );
      } else {
        // The Rust loop must not reach a second chat: step 1 top checks the
        // cancel flag and returns Aborted. If this branch fires, something
        // is wrong.
        mod.resolveCallback(callbackId, null, JSON.stringify({
          tool_calls: [], finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }));
      }
    };
    const toolCb = (callbackId: number) => {
      mod.resolveCallback(callbackId, null, JSON.stringify({ content: 'ok', is_error: false }));
    };

    const inFlight = mod.runTurnRust(
      { ...validParams, maxSteps: undefined },
      llmCb,
      toolCb,
    );

    // Let the gate await, then set the cancel flag before releasing the
    // chat so step 1 is guaranteed to observe it.
    await new Promise((r) => setTimeout(r, 20));
    mod.cancelTurn(validParams.turnId);
    releaseFirstChat();

    const result = await inFlight;

    expect(result.stopReason).toBe('Aborted');
    expect(result.steps).toBe(1);
    expect(result.llmRetries).toBe(0);
    expect(typeof result.eventsEmitted).toBe('number');
    expect(chatCallCount).toBe(1);
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
        modelAlias: 'test-model',
        modelId: 'test-model',
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

describe.skipIf(!nativeEntry)('napi runTurnRust — native mutating tools', () => {
  it('consults the permission callback before a native Write and runs it on allow', async () => {
    const os = await import('node:os');
    const workspaceRoot = os.default.tmpdir();
    const mod = loadNativeModule();

    const permissionCalls: string[] = [];
    let llmCalls = 0;
    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 2,
        workspaceRoot: workspaceRoot,
        nativeTools: true,
        tools: [
          {
            name: 'Write',
            description: 'Write a file',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}',
          },
        ],
        messages: [
          { role: 'user', content: 'write it' },
        ],
      },
      makeCallback(mod, () => {
        llmCalls += 1;
        const first = llmCalls === 1;
        return JSON.stringify({
          tool_calls: first
            ? [
                {
                  id: 'call-write-1',
                  name: 'Write',
                  arguments: { path: 'napi-permission-test.txt', content: 'granted' },
                },
              ]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
      undefined,
      makeCallback(mod, (req) => {
        const parsed = JSON.parse(req as string) as { tool_name: string };
        permissionCalls.push(parsed.tool_name);
        return JSON.stringify({ decision: 'allow' });
      }),
    );

    expect(result.stopReason).toBe('EndTurn');
    expect(permissionCalls).toEqual(['Write']);
    const { existsSync, readFileSync, rmSync } = await import('node:fs');
    const written = resolve(workspaceRoot, 'napi-permission-test.txt');
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, 'utf8')).toBe('granted');
    rmSync(written, { force: true });
  });

  it('returns the deny verdict as the tool result without executing', async () => {
    const mod = loadNativeModule();

    const result = await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 2,
        workspaceRoot: process.cwd(),
        nativeTools: true,
        tools: [
          {
            name: 'Write',
            description: 'Write a file',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}},"required":["path","content"]}',
          },
        ],
        messages: [{ role: 'user', content: 'write it' }],
      },
      makeCallback(mod, (req) => {
        const parsed = JSON.parse(req as string) as { messages: Array<{ role: string; content: string }> };
        void parsed;
        return JSON.stringify({
          tool_calls: [
            {
              id: 'call-write-deny',
              name: 'Write',
              arguments: { path: 'napi-denied-test.txt', content: 'nope' },
            },
          ],
          finish_reason: 'tool_calls',
          usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
      undefined,
      makeCallback(mod, () => JSON.stringify({ decision: 'deny', reason: 'user declined' })),
    );

    expect(result.stopReason).toBe('EndTurn');
    const { existsSync, rmSync } = await import('node:fs');
    expect(existsSync(resolve(process.cwd(), 'napi-denied-test.txt'))).toBe(false);
    rmSync(resolve(process.cwd(), 'napi-denied-test.txt'), { force: true });
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — concurrent MultiLLM providers', () => {
  it(
    'picks the first successful provider and ignores a failing peer',
    { timeout: 15_000 },
    async () => {
      const mod = loadNativeModule();

      const providerCalls: Array<{ model: string; ts: number }> = [];
      let winnerChatCount = 0;
      const t0 = Date.now();
      const llmCb = (callbackId: number) => {
        const req = JSON.parse(mod.getCallbackPayload(callbackId) ?? '{}') as {
          model_name?: string;
        };
        const model = req.model_name ?? '<missing>';
        providerCalls.push({ model, ts: Date.now() - t0 });
        if (model === 'loser-model') {
          mod.resolveCallback(callbackId, 'simulated provider failure', null);
          return;
        }
        winnerChatCount += 1;
        if (winnerChatCount === 1) {
          mod.resolveCallback(
            callbackId,
            null,
            JSON.stringify({
              tool_calls: [
                {
                  id: 'tc-multi',
                  name: 'Read',
                  arguments: '{"path":"x.txt"}',
                },
              ],
              finish_reason: 'tool_calls',
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            }),
          );
          return;
        }
        // Subsequent winner chats: complete the turn.
        mod.resolveCallback(
          callbackId,
          null,
          JSON.stringify({
            tool_calls: [],
            finish_reason: 'stop',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          }),
        );
      };
      const toolCb = (callbackId: number) => {
        mod.resolveCallback(callbackId, null, JSON.stringify({ content: 'ok', is_error: false }));
      };

      const result = await mod.runTurnRust(
        {
          ...validParams,
          maxSteps: undefined,
          providers: [
            { name: 'loser', model: 'loser-model', systemPrompt: 'always errors' },
            { name: 'winner', model: 'winner-model', systemPrompt: 'wins the race' },
          ],
          tools: [{ name: 'Read', description: 'r', inputSchema: '{"type":"object"}' }],
        },
        llmCb,
        toolCb,
      );

      expect(result.stopReason).toBe('EndTurn');
      expect(providerCalls.map((c) => c.model)).toContain('winner-model');
      expect(providerCalls.filter((c) => c.model === 'loser-model').length).toBeLessThanOrEqual(2);
    },
  );
});

describe.skipIf(!nativeEntry)('napi runTurnRust — native result finalization', () => {
  it('sends a natively-executed result through the host policy before the model sees it', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-finalize-'));
    fs.writeFileSync(path.join(workspaceRoot, 'large.txt'), 'a'.repeat(5000));
    const mod = loadNativeModule();

    const nativeEvents: Array<{ content?: string }> = [];
    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let finalizeCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"}}}',
          },
        ],
        messages: [{ role: 'user', content: 'read it' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [{ id: 'call-read-1', name: 'Read', arguments: { path: 'large.txt' } }]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: 'HOST EXECUTED', is_error: false })),
      makeCallback(mod, (req) => {
        const event = JSON.parse(req) as { type?: string };
        if (event.type === 'tool.native') nativeEvents.push(event as { content?: string });
        return '';
      }),
      makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
      makeCallback(mod, (req) => {
        finalizeCalls += 1;
        const request = JSON.parse(req) as {
          tool_name: string;
          tool_call_id: string;
          content: string;
        };
        expect(request.tool_name).toBe('Read');
        // Stand in for truncation: replace the body the way the host policy would.
        return JSON.stringify({
          content: `TRUNCATED(${request.content.length})`,
          is_error: false,
          note: undefined,
        });
      }),
    );

    expect(finalizeCalls).toBe(1);
    // The transcript records what the model was shown, not the raw output.
    expect(nativeEvents[0]?.content).toMatch(/^TRUNCATED\(\d+\)$/);
    // And the finalized text is what re-enters the model context.
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('TRUNCATED(');
    expect(followUp).not.toContain('aaaaaaaaaa');
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — rustSelfContained (P26 批 1)', () => {
  it('rejects when rustSelfContained is true and no native LLM transport is configured', async () => {
    const mod = loadNativeModule();
    let llmCalls = 0;

    await expect(
      mod.runTurnRust(
        {
          ...validParams,
          // Both native_llm and providers are absent — the only configured
          // path would be the host proxy, which the flag must forbid.
          native_llm: undefined,
          providers: undefined,
          rustSelfContained: true,
          maxSteps: 1,
        },
        makeCallback(mod, (_req) => {
          llmCalls += 1;
          return JSON.stringify({
            content: 'should not be called',
            finish_reason: 'stop',
            usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
          });
        }),
        makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
      ),
    ).rejects.toThrow(/rustSelfContained=true requires/);

    // The LLM callback must not be invoked when the engine fails fast
    // at construction. Any llm_chat hit would mean we silently fell
    // back to host/llm_chat, defeating the migration switch.
    expect(llmCalls).toBe(0);
  });

  it('falls back to host proxy when rustSelfContained is not set (backwards compat)', async () => {
    const mod = loadNativeModule();

    // No native_llm, no providers, no rustSelfContained. The default
    // behaviour (host proxy via llm_chat callback) must still work.
    const result = await mod.runTurnRust(
      {
        ...validParams,
        native_llm: undefined,
        providers: undefined,
        rustSelfContained: undefined,
        maxSteps: 1,
      },
      makeCallback(mod, (_req) =>
        JSON.stringify({
          tool_calls: [],
          content: 'hello from host proxy',
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
      makeCallback(mod, (_req) => JSON.stringify({ content: '', is_error: false })),
    );

    // The result should complete normally via the host proxy path.
    expect((result as { stopReason: string }).stopReason).toBe('EndTurn');
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — mid-turn steering drain channel', () => {
  // Port 9 (discard) refuses connections immediately, so a turn that really
  // picks the native transport fails locally instead of reaching a provider.
  // The drain happens at the step head — before the request is sent — so the
  // dead endpoint does not hide whether the channel was consulted.
  const deadNativeLlm = {
    protocol: 'openai',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'sk-test',
    model: 'test-model',
  };

  it('consults the host for steering when the engine owns the history', { timeout: 40_000 }, async () => {
    const mod = loadNativeModule();
    let drains = 0;
    let hostChatCalls = 0;

    await mod
      .runTurnRust(
        {
          ...validParams,
          maxSteps: 1,
          nativeLlm: deadNativeLlm,
        },
        makeCallback(mod, () => {
          hostChatCalls += 1;
          return JSON.stringify({ content: '', tool_calls: [], finish_reason: 'stop' });
        }),
        makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
        makeCallback(mod, () => ''),
        makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
        makeCallback(mod, (req: string) => req),
        makeCallback(mod, () => {
          drains += 1;
          return JSON.stringify([{ role: 'user', content: 'steered mid-turn' }]);
        }),
      )
      .catch(() => undefined);

    expect(drains).toBe(1);
    expect(hostChatCalls).toBe(0);
  });

  it('never consults the drain channel for a host-proxied provider', async () => {
    const mod = loadNativeModule();
    let drains = 0;

    await mod.runTurnRust(
      { ...validParams, maxSteps: 1 },
      makeCallback(mod, () =>
        JSON.stringify({
          content: 'proxied',
          tool_calls: [],
          finish_reason: 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        }),
      ),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
      makeCallback(mod, (req: string) => req),
      makeCallback(mod, () => {
        drains += 1;
        return JSON.stringify([]);
      }),
    );

    expect(drains).toBe(0);
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — local tool result truncation (P26 批 4)', () => {
  it('truncates a large native result in-process and skips the host finalize seam', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-b4-'));
    // 30 lines × 2_000 chars = 60_000 raw chars. The native Read tool
    // caps each line at 2_000 + '[...truncated]' marker, so the post-Read
    // content is ~30 × 2_020 = 60_600 chars — well over the 50_000
    // truncator cap. A single 60k-line would not trigger truncation
    // because Read already reduces it to ~2_000 chars.
    const huge = Array.from({ length: 30 }, () => 'a'.repeat(2_000) + '\n').join('');
    fs.writeFileSync(path.join(workspaceRoot, 'huge.txt'), huge);
    const mod = loadNativeModule();

    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let finalizeCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        // rustSelfContained wires up the local truncator (the seam under
        // test). It also requires a non-empty `providers` or `native_llm`
        // so the engine can serve an LLM call; we use a single mock
        // provider that still routes through the host's llm_chat
        // callback via MultiLLM, which is enough to drive the tool
        // execution path under test.
        rustSelfContained: true,
        providers: [{ name: 'mock', model: 'mock-model', systemPrompt: '' }],
        tools: [
          {
            name: 'Read',
            description: 'Read a file',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"}}}',
          },
        ],
        messages: [{ role: 'user', content: 'read it' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [{ id: 'call-read-b4', name: 'Read', arguments: { path: 'huge.txt' } }]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
      makeCallback(mod, () => {
        finalizeCalls += 1;
        return JSON.stringify({ content: 'HOST FINALIZE WAS CALLED', is_error: false });
      }),
    );

    // The local truncator handled the result — the host's finalize seam
    // must NOT be hit. If the Rust engine is doing its job, finalizeCalls
    // stays at 0; if it accidentally fell back, the host would have run
    // once and the assert would fail.
    expect(finalizeCalls).toBe(0);
    // The follow-up LLM request carries the *truncated* model-facing
    // content, not the raw 60k-char file body. With 30 lines × 2_000
    // chars the shaped text is ~60_111 chars, well over the 50_000 cap,
    // so the persisted-pointer branch runs (not the inline-pointer one).
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('Tool output exceeded');
    expect(followUp).toContain('output_path:');
    expect(followUp).toContain('tool_name: Read');
    expect(followUp).toContain('tool_call_id: call-read-b4');
    expect(followUp).toContain('output_size_chars: 60111');
    expect(followUp).toContain('[preview:');
    // The full 60_111-char file body is *not* in the model context —
    // the middle ~54k chars were elided and only a head/tail preview
    // remain. The `[elided: chars [a, b)]` marker is the proof that
    // the truncator actually removed content, not just labelled it.
    expect(followUp).toContain('[elided: chars [4096, 59087)]');
    expect(followUp).toContain('[preview: chars [0, 4096)]');
    expect(followUp).toContain('[preview: chars [59087, 60111)]');
    // The spill directory was created and contains the retained text.
    const spillDir = path.join(workspaceRoot, '.kimi', 'spill');
    expect(fs.existsSync(spillDir)).toBe(true);
    const spillFiles = fs.readdirSync(spillDir);
    expect(spillFiles.length).toBeGreaterThan(0);
    const saved = fs.readFileSync(path.join(spillDir, spillFiles[0]!), 'utf8');
    expect(saved.length).toBeGreaterThanOrEqual(50_000);
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — pure I/O tools (P26 批 2)', () => {
  it('executes ListDirectory natively and captures directory tree in context', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-b2-'));
    fs.mkdirSync(path.join(workspaceRoot, 'subfolder'));
    fs.writeFileSync(path.join(workspaceRoot, 'subfolder', 'child.txt'), 'child content');
    fs.writeFileSync(path.join(workspaceRoot, 'root-file.ts'), 'console.log(1)');

    const mod = loadNativeModule();
    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let hostExecuteCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        rustSelfContained: true,
        providers: [{ name: 'mock', model: 'mock-model', systemPrompt: '' }],
        tools: [
          {
            name: 'ListDirectory',
            description: 'List files in directory',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"}}}',
          },
        ],
        messages: [{ role: 'user', content: 'list dir' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [{ id: 'call-list-dir', name: 'ListDirectory', arguments: { path: '.' } }]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => {
        hostExecuteCalls += 1;
        return JSON.stringify({ content: 'HOST WAS CALLED', is_error: false });
      }),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
    );

    expect(hostExecuteCalls).toBe(0);
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('subfolder/');
    expect(followUp).toContain('child.txt');
    expect(followUp).toContain('root-file.ts');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('executes FetchURL natively and blocks private SSRF addresses', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-b2-ssrf-'));

    const mod = loadNativeModule();
    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let hostExecuteCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        rustSelfContained: true,
        providers: [{ name: 'mock', model: 'mock-model', systemPrompt: '' }],
        tools: [
          {
            name: 'FetchURL',
            description: 'Fetch URL',
            inputSchema: '{"type":"object","properties":{"url":{"type":"string"}}}',
          },
        ],
        messages: [{ role: 'user', content: 'fetch it' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [{ id: 'call-fetch-ssrf', name: 'FetchURL', arguments: { url: 'http://127.0.0.1:8080/admin' } }]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => {
        hostExecuteCalls += 1;
        return JSON.stringify({ content: 'HOST WAS CALLED', is_error: false });
      }),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
    );

    expect(hostExecuteCalls).toBe(0);
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('Failed to fetch URL: Refusing to fetch private address');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — local permission engine (P26 批 3)', () => {
  it('evaluates YOLO mode locally in Rust and bypasses host check_permission', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-p3-yolo-'));

    const mod = loadNativeModule();
    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let hostPermissionCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        rustSelfContained: true,
        policySnapshotJson: JSON.stringify({
          mode: 'yolo',
        }),
        providers: [{ name: 'mock', model: 'mock-model', systemPrompt: '' }],
        tools: [
          {
            name: 'Write',
            description: 'Write file',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}}}',
          },
        ],
        messages: [{ role: 'user', content: 'write test file' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [{ id: 'call-write-yolo', name: 'Write', arguments: { path: 'yolo-test.txt', content: 'yolo content' } }]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: 'HOST EXEC WAS CALLED', is_error: false })),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => {
        hostPermissionCalls += 1;
        return JSON.stringify({ decision: 'allow' });
      }),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
    );

    // Host permission callback must NOT be called because YOLO mode is evaluated locally in Rust
    expect(hostPermissionCalls).toBe(0);
    const written = path.join(workspaceRoot, 'yolo-test.txt');
    expect(fs.existsSync(written)).toBe(true);
    expect(fs.readFileSync(written, 'utf8')).toBe('yolo content');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });

  it('evaluates user deny rules locally in Rust and denies write immediately', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-p3-deny-'));

    const mod = loadNativeModule();
    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let hostPermissionCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        rustSelfContained: true,
        policySnapshotJson: JSON.stringify({
          mode: 'yolo',
          deny_rules: ['Write(blocked.txt)'],
        }),
        providers: [{ name: 'mock', model: 'mock-model', systemPrompt: '' }],
        tools: [
          {
            name: 'Write',
            description: 'Write file',
            inputSchema: '{"type":"object","properties":{"path":{"type":"string"},"content":{"type":"string"}}}',
          },
        ],
        messages: [{ role: 'user', content: 'write blocked file' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [{ id: 'call-write-blocked', name: 'Write', arguments: { path: 'blocked.txt', content: 'should not land' } }]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: 'HOST EXEC WAS CALLED', is_error: false })),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => {
        hostPermissionCalls += 1;
        return JSON.stringify({ decision: 'allow' });
      }),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
    );

    // Host permission callback must NOT be called
    expect(hostPermissionCalls).toBe(0);
    const written = path.join(workspaceRoot, 'blocked.txt');
    expect(fs.existsSync(written)).toBe(false);
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('Denied by user rule: Write(blocked.txt)');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});



describe.skipIf(!nativeEntry)('napi runTurnRust — native subagents (P28 批 3 接线)', () => {
  it('executes invoke_subagent natively and runs a real subagent turn', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-p28-'));

    const mod = loadNativeModule();
    const llmRequests: Array<{ messages: Array<{ content?: string }> }> = [];
    let hostExecuteCalls = 0;

    await mod.runTurnRust(
      {
        ...validParams,
        maxSteps: 3,
        workspaceRoot,
        nativeTools: true,
        rustSelfContained: true,
        providers: [{ name: 'mock', model: 'mock-model', systemPrompt: '' }],
        tools: [
          {
            name: 'invoke_subagent',
            description: 'Launch subagents',
            inputSchema:
              '{"type":"object","properties":{"Subagents":{"type":"array","items":{"type":"object"}}}}',
          },
        ],
        messages: [{ role: 'user', content: 'spawn a research subagent' }],
      },
      makeCallback(mod, (req) => {
        llmRequests.push(JSON.parse(req));
        const first = llmRequests.length === 1;
        return JSON.stringify({
          tool_calls: first
            ? [
                {
                  id: 'call-sub-1',
                  name: 'invoke_subagent',
                  arguments: {
                    Subagents: [
                      { TypeName: 'research', Role: 'Napi Searcher', Prompt: 'search the codebase' },
                    ],
                  },
                },
              ]
            : [],
          finish_reason: first ? 'tool_calls' : 'stop',
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        });
      }),
      makeCallback(mod, () => {
        hostExecuteCalls += 1;
        return JSON.stringify({ content: 'HOST WAS CALLED', is_error: false });
      }),
      makeCallback(mod, () => ''),
      makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
      makeCallback(mod, () => JSON.stringify({ content: '', is_error: false })),
    );

    // The subagent tool ran natively in Rust, not through the host.
    expect(hostExecuteCalls).toBe(0);
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('spawned');
    expect(followUp).toContain('Napi Searcher');

    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  });
});

describe.skipIf(!nativeEntry)('napi runTurnRust — ask_user_question (第 4 批)', () => {
  const askArgs = {
    questions: [
      {
        question: 'Which approach should I take?',
        header: 'Style',
        options: [
          { label: 'Option A (Recommended)', description: 'Fast, less flexible' },
          { label: 'Option B', description: 'Slower, more flexible' },
        ],
        multi_select: false,
      },
    ],
    background: false,
  };

  // Drive one turn whose first llm_chat asks ask_user_question natively.
  // Returns the llm requests (the tool result the model sees is in
  // `llmRequests[1].messages`) and the raw ask_question wire requests.
  async function runAskTurn(
    mod: ReturnType<typeof loadNativeModule>,
    askQuestionCb: ((request: string) => string) | undefined,
    args: Record<string, unknown> = askArgs,
  ): Promise<{
    llmRequests: Array<{ messages: Array<{ role: string; content: string }> }>;
    askQuestionRequests: string[];
  }> {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-aq-'));
    const llmRequests: Array<{ messages: Array<{ role: string; content: string }> }> = [];
    const askQuestionRequests: string[] = [];
    try {
      await mod.runTurnRust(
        {
          ...validParams,
          maxSteps: 2,
          workspaceRoot,
          nativeTools: true,
          tools: [
            {
              name: 'ask_user_question',
              description: 'Ask the user questions',
              inputSchema: '{"type":"object","properties":{"questions":{"type":"array"}}}',
            },
          ],
          messages: [{ role: 'user', content: 'ask me something' }],
        },
        makeCallback(mod, (req) => {
          llmRequests.push(JSON.parse(req));
          const first = llmRequests.length === 1;
          return JSON.stringify({
            tool_calls: first
              ? [{ id: 'call-ask-1', name: 'ask_user_question', arguments: args }]
              : [],
            finish_reason: first ? 'tool_calls' : 'stop',
            usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
          });
        }),
        makeCallback(mod, () =>
          JSON.stringify({ content: 'HOST EXEC WAS CALLED', is_error: false }),
        ),
        undefined,
        makeCallback(mod, () => JSON.stringify({ decision: 'allow' })),
        undefined,
        undefined,
        askQuestionCb
          ? makeCallback(mod, (req) => {
              askQuestionRequests.push(req);
              return askQuestionCb(req);
            })
          : undefined,
      );
    } finally {
      fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
    return { llmRequests, askQuestionRequests };
  }

  it('executes the tool natively and maps an answered response into the model context', async () => {
    const mod = loadNativeModule();
    let receivedRequest: Record<string, unknown> | null = null;

    const { llmRequests, askQuestionRequests } = await runAskTurn(mod, (req) => {
      receivedRequest = JSON.parse(req);
      return JSON.stringify({
        answers: { 'Which approach should I take?': 'Option A (Recommended)' },
        method: 'enter',
      });
    });

    expect(askQuestionRequests.length).toBe(1);
    expect(receivedRequest).not.toBeNull();
    const wire = receivedRequest as Record<string, unknown>;
    expect(typeof wire.question_id).toBe('string');
    expect((wire.question_id as string).startsWith('question_')).toBe(true);
    const questions = wire.questions as Array<Record<string, unknown>>;
    expect(questions.length).toBe(1);
    expect(questions[0]?.question).toBe('Which approach should I take?');
    expect(questions[0]?.header).toBe('Style');
    const options = questions[0]?.options as Array<Record<string, unknown>>;
    expect(options.map((o) => o.label)).toEqual(['Option A (Recommended)', 'Option B']);
    // The formatted answer re-enters the model context as the tool result.
    const toolMsg = llmRequests[1]?.messages.find((m) => m.role === 'tool');
    const parsed = JSON.parse(toolMsg?.content ?? '{}') as Record<string, unknown>;
    expect(parsed.answers).toEqual({
      'Which approach should I take?': 'Option A (Recommended)',
    });
  });

  it('maps a dismissed response to the v2 note', async () => {
    const mod = loadNativeModule();

    const { llmRequests } = await runAskTurn(mod, () =>
      JSON.stringify({
        answers: {},
        note: 'User dismissed the question without answering.',
      }),
    );

    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('User dismissed the question without answering.');
  });

  it('maps a cancelled response to an error tool result', async () => {
    const mod = loadNativeModule();

    const { llmRequests } = await runAskTurn(mod, () =>
      JSON.stringify({ cancelled: true, reason: 'turn_ended' }),
    );

    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('cancelled');
    expect(followUp).toContain('turn_ended');
  });

  it('returns the unsupported-host message when no ask_question_cb is provided', async () => {
    const mod = loadNativeModule();

    const { llmRequests } = await runAskTurn(mod, undefined);

    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('Do NOT call this tool again');
  });

  it('forwards background:true to the host wire request', async () => {
    const mod = loadNativeModule();
    let receivedRequest: Record<string, unknown> | null = null;

    const { llmRequests } = await runAskTurn(
      mod,
      (req) => {
        receivedRequest = JSON.parse(req);
        // Background questions return the v2 background task output
        // verbatim in `note` (design doc 3.3).
        return JSON.stringify({
          answers: {},
          note: 'task_id: question_abc\ndescription: Which approach should I take?\nstatus: running\nautomatic_notification: true',
        });
      },
      { ...askArgs, background: true },
    );

    expect((receivedRequest as Record<string, unknown>).background).toBe(true);
    const followUp = JSON.stringify(llmRequests[1]?.messages ?? []);
    expect(followUp).toContain('task_id: question_abc');
    expect(followUp).toContain('status: running');
  });
});

// ── EngineSession handle (M1d) ─────────────────────────────────────────────
// The napi boundary upgrades from "one call per turn" to a session handle:
// admission, the pending FIFO, the pump, turn ids, cancellation, and
// quiescence live engine-side across turns.

describe.skipIf(!nativeEntry)('napi engine session handle (M1d)', () => {
  const stopResponse = JSON.stringify({
    content: 'hello!',
    tool_calls: [],
    finish_reason: 'stop',
    usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
  });

  function createSession(mod: ReturnType<typeof loadNativeModule>): Promise<string> {
    return mod.createEngineSession(
      {
        turnId: 'ignored',
        systemPrompt: 'You are a test assistant.',
        modelName: 'test-model',
        messages: [],
        tools: [],
        maxSteps: 5,
      },
      makeCallback(mod, () => stopResponse),
      makeCallback(mod, () => JSON.stringify({ content: 'ok', is_error: false })),
    ) as Promise<string>;
  }

  it('creates a session, runs an enqueued turn, and folds history', async () => {
    const mod = loadNativeModule();
    const sessionId = (await createSession(mod)) as string;
    expect(sessionId).toMatch(/^session-/);

    const turnId = mod.sessionEnqueueTurn(
      sessionId,
      JSON.stringify({ role: 'user', content: 'hi' }),
      'newTurn',
    ) as number;
    expect(typeof turnId).toBe('number');

    const outcome = (await mod.sessionTurnOutcome(sessionId, turnId)) as {
      status: string;
      result: { stopReason: string; steps: number } | null;
    };
    expect(outcome.status).toBe('ran');
    expect(outcome.result?.stopReason).toBe('EndTurn');
    expect(outcome.result?.steps).toBe(1);

    // The turn's messages fold into the cross-turn history (assistant reply
    // + user prompt; the system message is excluded).
    expect(mod.sessionHistoryLen(sessionId)).toBe(2);
    expect(mod.sessionIsSettled(sessionId)).toBe(true);
    await mod.sessionSettled(sessionId);

    mod.sessionDispose(sessionId);
  });

  it('cancels a queued turn before it starts and keeps the active turn running', async () => {
    const mod = loadNativeModule();
    let release: (() => void) | undefined;
    const sessionId = (await mod.createEngineSession(
      {
        turnId: 'ignored',
        systemPrompt: 'You are a test assistant.',
        modelName: 'test-model',
        messages: [],
        tools: [],
        maxSteps: 5,
      },
      // Step 0 of the first turn parks on this gate; the response resolves
      // when the test releases it.
      makeCallback(mod, () => {
        return new Promise<string>((resolve) => {
          release = () => resolve(stopResponse);
        });
      }),
      makeCallback(mod, () => JSON.stringify({ content: 'ok', is_error: false })),
    )) as string;

    const activeId = mod.sessionEnqueueTurn(
      sessionId,
      JSON.stringify({ role: 'user', content: 'gated' }),
      'newTurn',
    ) as number;
    // Wait until the pump claims the first turn.
    for (let i = 0; i < 100; i += 1) {
      const status = mod.sessionStatus(sessionId) as { activeTurnId: number | null };
      if (status.activeTurnId === activeId) break;
      await new Promise((r) => setTimeout(r, 10));
    }
    const status = mod.sessionStatus(sessionId) as { activeTurnId: number | null };
    expect(status.activeTurnId).toBe(activeId);

    const queuedId = mod.sessionEnqueueTurn(
      sessionId,
      JSON.stringify({ role: 'user', content: 'queued' }),
      'newTurn',
    ) as number;
    expect(mod.sessionCancelTurn(sessionId, queuedId)).toBe(true);
    const queuedOutcome = (await mod.sessionTurnOutcome(sessionId, queuedId)) as {
      status: string;
    };
    expect(queuedOutcome.status).toBe('cancelledBeforeStart');

    // Release the gate; the active turn runs to completion.
    release?.();
    const activeOutcome = (await mod.sessionTurnOutcome(sessionId, activeId)) as {
      status: string;
    };
    expect(activeOutcome.status).toBe('ran');
    await mod.sessionSettled(sessionId);
    mod.sessionDispose(sessionId);
  });
});

// ── EngineSessionHandle (typed wrapper over the session surface) ──────────

describe.skipIf(!nativeEntry)('EngineSessionHandle (M1d wrapper)', () => {
  it('drives a turn through the typed handle and folds history', async () => {
    const { EngineSessionHandle } = await import('./session-handle');
    const handle = await EngineSessionHandle.create(
      {
        turnId: 'ignored',
        systemPrompt: 'You are a test assistant.',
        modelName: 'test-model',
        messages: [],
        tools: [],
        maxSteps: 5,
      },
      {
        llmChat: async () =>
          JSON.stringify({
            content: 'hello!',
            tool_calls: [],
            finish_reason: 'stop',
            usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
          }),
        executeTool: async () => JSON.stringify({ content: 'ok', is_error: false }),
      },
    );
    expect(handle.id).toMatch(/^session-/);

    const turnId = await handle.enqueueTurn({ role: 'user', content: 'hi' }, 'newTurn');
    const outcome = await handle.turnOutcome(turnId);
    expect(outcome.status).toBe('ran');
    expect(outcome.result?.stopReason).toBe('EndTurn');
    expect(outcome.result?.steps).toBe(1);
    expect(await handle.historyLen()).toBe(2);
    expect(await handle.isSettled()).toBe(true);
    await handle.settled();

    // A second turn continues the cross-turn history.
    const second = await handle.enqueueTurn({ role: 'user', content: 'again' }, 'newTurn');
    const secondOutcome = await handle.turnOutcome(second);
    expect(secondOutcome.status).toBe('ran');
    expect(await handle.historyLen()).toBe(4);

    await handle.dispose();
  });

  it('cancels a queued turn through the handle', async () => {
    const { EngineSessionHandle } = await import('./session-handle');
    let release: (() => void) | undefined;
    const handle = await EngineSessionHandle.create(
      {
        turnId: 'ignored',
        systemPrompt: 'test',
        modelName: 'm',
        messages: [],
        tools: [],
        maxSteps: 5,
      },
      {
        llmChat: async () =>
          new Promise<string>((resolve) => {
            release = () =>
              resolve(
                JSON.stringify({
                  content: 'done',
                  tool_calls: [],
                  finish_reason: 'stop',
                  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
                }),
              );
          }),
        executeTool: async () => JSON.stringify({ content: 'ok', is_error: false }),
      },
    );

    const activeId = await handle.enqueueTurn({ role: 'user', content: 'gated' }, 'newTurn');
    for (let i = 0; i < 100 && (await handle.status()).activeTurnId !== activeId; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect((await handle.status()).activeTurnId).toBe(activeId);

    const queuedId = await handle.enqueueTurn({ role: 'user', content: 'queued' }, 'newTurn');
    expect(await handle.cancelTurn(queuedId)).toBe(true);
    const queuedOutcome = await handle.turnOutcome(queuedId);
    expect(queuedOutcome.status).toBe('cancelledBeforeStart');

    release?.();
    expect((await handle.turnOutcome(activeId)).status).toBe('ran');
    await handle.settled();
    await handle.dispose();
  });
});

describe.skipIf(!nativeEntry)('EngineSessionHandle quiescence (M1c via handle)', () => {
  it('parks turns during quiescence and replays them on release', async () => {
    const { EngineSessionHandle } = await import('./session-handle');
    let chatCalls = 0;
    let release: (() => void) | undefined;
    const immediateResponse = JSON.stringify({
      content: 'done',
      tool_calls: [],
      finish_reason: 'stop',
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
    });
    const handle = await EngineSessionHandle.create(
      {
        turnId: 'ignored',
        systemPrompt: 'test',
        modelName: 'm',
        messages: [],
        tools: [],
        maxSteps: 5,
      },
      {
        // The first chat (the replayed held turn) answers immediately; the
        // second (the active turn) parks on a gate the test controls.
        llmChat: async () => {
          chatCalls += 1;
          if (chatCalls === 1) return immediateResponse;
          return new Promise<string>((resolve) => {
            release = () => resolve(immediateResponse);
          });
        },
        executeTool: async () => JSON.stringify({ content: 'ok', is_error: false }),
      },
    );

    expect(await handle.tryAcquireQuiescence()).toBe(true);
    const heldId = await handle.enqueueTurn({ role: 'user', content: 'held' }, 'newTurn');
    expect(await handle.isSettled()).toBe(false);

    await handle.releaseQuiescence();
    const outcome = await handle.turnOutcome(heldId);
    expect(outcome.status).toBe('ran');
    await handle.settled();

    const activeId = await handle.enqueueTurn({ role: 'user', content: 'active' }, 'newTurn');
    for (let i = 0; i < 100 && (await handle.status()).activeTurnId !== activeId; i += 1) {
      await new Promise((r) => setTimeout(r, 10));
    }
    // The turn parks on the gate, so the window must stay denied until it ends.
    expect(await handle.tryAcquireQuiescence()).toBe(false);
    release?.();
    expect((await handle.turnOutcome(activeId)).status).toBe('ran');
    await handle.settled();
    await handle.dispose();
  });
});
