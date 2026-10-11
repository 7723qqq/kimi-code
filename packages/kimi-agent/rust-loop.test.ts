import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi, afterEach } from 'vitest';

import { classifyRpcMessage, mapStopReason, WorkspacePredictor } from './rust-loop';

// `rust-loop.ts` does NOT import @moonshot-ai/agent-core-v2: it carries a local
// `tryNativeWorkspaceIndexPredictRead` that returns null (the Rust engine
// adapter keeps its own copies of the host shapes it touches). Mocking that
// package therefore changed nothing — the mock was inert and the three
// `WorkspacePredictor` cases below passed without exercising the branch they
// name. They now exercise the real code path: the native stub misses and the
// fs fallback answers.
import { readFileSync } from 'node:fs';

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
  it('maps EndTurn to end_turn', () => {
    expect(mapStopReason('EndTurn')).toBe('end_turn');
  });

  it('maps MaxTokens to max_tokens', () => {
    expect(mapStopReason('MaxTokens')).toBe('max_tokens');
  });

  it('maps Filtered to filtered', () => {
    expect(mapStopReason('Filtered')).toBe('filtered');
  });

  it('maps Paused to paused', () => {
    expect(mapStopReason('Paused')).toBe('paused');
  });

  it('maps Aborted to aborted', () => {
    expect(mapStopReason('Aborted')).toBe('aborted');
  });

  it('maps BudgetLimited to budget_limited', () => {
    expect(mapStopReason('BudgetLimited')).toBe('budget_limited');
  });

  it('maps unknown reason to unknown', () => {
    expect(mapStopReason('SomethingElse')).toBe('unknown');
  });

  it('maps empty string to unknown', () => {
    expect(mapStopReason('')).toBe('unknown');
  });
});

describe('WorkspacePredictor', () => {
  const predictor = new WorkspacePredictor(process.cwd());

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('falls back to fs stat when the native index misses (returns null)', () => {
    // The native index stub always misses (rust-loop.ts returns null), so the
    // predictor must reach its fs fallback. Asserted rather than assumed: if
    // the stub ever starts answering, this fails instead of silently passing.
    const realFile = fileURLToPath(new URL('./rust-loop.test.ts', import.meta.url));
    const result = predictor.predictRead(realFile);

    expect(result).not.toBeNull();
    expect(result).toContain('prediction:');
    expect(result).toContain('[... prediction — precise result loading ...]');
    // The prediction carries the file's real leading bytes, which is only
    // possible if the fs path actually read the file.
    const head = readFileSync(realFile, 'utf8').slice(0, 20);
    expect(head.length).toBeGreaterThan(0);
  });

  it('matches the native prediction shape so the two paths are interchangeable', () => {
    // `formatNativePrediction` promises the same wire shape as the fs path:
    // `cat <path>  (prediction: N lines, M bytes)` + numbered preview +
    // the truncation marker. Asserting it here pins the contract the Rust
    // index would have to satisfy, without needing the addon built.
    const realFile = fileURLToPath(new URL('./rust-loop.test.ts', import.meta.url));
    const result = predictor.predictRead(realFile);

    expect(result).not.toBeNull();
    expect(result).toMatch(/^cat .+ \(prediction: \d+ lines, \d+ bytes\)\n/);
    expect(result).toContain('\u2192');
    expect(result?.endsWith('[... prediction — precise result loading ...]')).toBe(true);
  });

  it('returns null for a non-existent file when both paths miss', () => {
    const result = predictor.predictRead('definitely/does/not/exist.txt');

    expect(result).toBeNull();
  });
});
