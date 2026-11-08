import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ModelResponse } from '../src/benchmark/runner';
import type { WireMessage } from '../src/llm-caller';
import {
  MEASURE_MAX_TOOL_ROUNDS,
  MeasureTurnExhaustedError,
  runMeasureTurn,
  type MeasureTurn,
} from '../src/measure/toolLoop';
import { MEASURE_TOOLS } from '../src/measure/tools';

let tempHome: string | undefined;

afterEach(() => {
  if (tempHome !== undefined) {
    rmSync(tempHome, { recursive: true, force: true });
    tempHome = undefined;
  }
});

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'measure-loop-'));
  writeFileSync(join(root, 'alpha.ts'), 'export const alpha = 1;\n');
  tempHome = root;
  return root;
}

function responseOf(content: string, toolCalls: ModelResponse['toolCalls'] = []): ModelResponse {
  return { content, toolCalls, usage: { input: 1, output: 1 }, latencyMs: 1 };
}

function recordingTurn(responses: readonly ModelResponse[]): {
  readonly turn: MeasureTurn;
  readonly calls: () => readonly WireMessage[][];
} {
  const calls: WireMessage[][] = [];
  let index = 0;
  return {
    calls: () => calls,
    turn: async (messages) => {
      calls.push([...messages]);
      const response = responses[Math.min(index, responses.length - 1)]!;
      index += 1;
      return response;
    },
  };
}

const OPTIONS = {
  systemPrompt: 'rewrite the draft',
  input: 'Working directory: /repo\n\n<draft>\nfix it\n</draft>',
  tools: MEASURE_TOOLS,
};

describe('runMeasureTurn', () => {
  test('executes a tool call and returns the rewrite that follows', async () => {
    const root = makeWorkspace();
    const recorded = recordingTurn([
      responseOf('', [{ id: 'call_1', name: 'Read', input: JSON.stringify({ path: 'alpha.ts' }) }]),
      responseOf('Fix the alpha export.'),
    ]);

    const response = await runMeasureTurn({ ...OPTIONS, cwd: root, turn: recorded.turn });

    expect(response.content).toBe('Fix the alpha export.');
    expect(recorded.calls()).toHaveLength(2);
    const secondCall = recorded.calls()[1]!;
    const toolMessage = secondCall.find((message) => message.role === 'tool');
    expect(toolMessage?.role === 'tool' && toolMessage.content).toContain('export const alpha = 1;');
  });

  test('stops as soon as the model answers', async () => {
    const root = makeWorkspace();
    const recorded = recordingTurn([responseOf('Fix the alpha export.')]);

    await runMeasureTurn({ ...OPTIONS, cwd: root, turn: recorded.turn });

    expect(recorded.calls()).toHaveLength(1);
  });

  test("carries the provider's tool call id into the tool message", async () => {
    const root = makeWorkspace();
    const recorded = recordingTurn([
      responseOf('', [{ id: 'call_42', name: 'Glob', input: JSON.stringify({ pattern: '*.ts' }) }]),
      responseOf('Done.'),
    ]);

    await runMeasureTurn({ ...OPTIONS, cwd: root, turn: recorded.turn });

    const secondCall = recorded.calls()[1]!;
    const assistant = secondCall.find((message) => message.role === 'assistant');
    const tool = secondCall.find((message) => message.role === 'tool');
    expect(assistant?.role === 'assistant' && assistant.toolCalls?.[0]?.id).toBe('call_42');
    expect(tool?.role === 'tool' && tool.toolCallId).toBe('call_42');
    expect(tool?.role === 'tool' && tool.content).toContain('alpha.ts');
  });

  test('sums the token usage of every round', async () => {
    const root = makeWorkspace();
    const recorded = recordingTurn([
      responseOf('', [{ id: 'call_1', name: 'Glob', input: JSON.stringify({ pattern: '*.ts' }) }]),
      responseOf('Done.'),
    ]);

    const response = await runMeasureTurn({ ...OPTIONS, cwd: root, turn: recorded.turn });

    expect(response.usage).toEqual({ input: 2, output: 2, cacheRead: 0 });
  });

  test('a turn that ends with neither text nor a tool call is refused', async () => {
    const root = makeWorkspace();
    const recorded = recordingTurn([responseOf('')]);

    await expect(runMeasureTurn({ ...OPTIONS, cwd: root, turn: recorded.turn })).rejects.toBeInstanceOf(
      MeasureTurnExhaustedError,
    );
  });

  test('caps the rounds instead of investigating forever', async () => {
    const root = makeWorkspace();
    const recorded = recordingTurn([
      responseOf('', [{ id: 'call_1', name: 'Glob', input: JSON.stringify({ pattern: '*.ts' }) }]),
    ]);

    const attempt = runMeasureTurn({ ...OPTIONS, cwd: root, turn: recorded.turn });
    await expect(attempt).rejects.toBeInstanceOf(MeasureTurnExhaustedError);
    await expect(attempt).rejects.toThrow(`no rewrite after ${String(MEASURE_MAX_TOOL_ROUNDS)}`);
    expect(recorded.calls()).toHaveLength(MEASURE_MAX_TOOL_ROUNDS);
  });
});
