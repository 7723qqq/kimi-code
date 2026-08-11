/**
 * `loop` domain — shared test fixtures for the loop e2e suites.
 *
 * Ported from the v1 `packages/agent-core/test/loop/fixtures/*` helpers:
 * a scripted `MessageStepRequest` factory, a deferred-promise utility, an
 * echo tool that records its invocations, and a tool-registration helper
 * that activates the tool through the profile.
 */

import { MessageStepRequest } from '#/agent/loop/stepRequest';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentProfileService } from '#/index';
import type {
  ExecutableTool,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import {
  createTestAgent,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../../harness';

export interface Deferred<T = void> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

/** A user-text turn request with `admission: 'newTurn'`, like `rpc.prompt`. */
export function nextTurnMessage(text: string): MessageStepRequest {
  return new MessageStepRequest(
    {
      role: 'user',
      content: [{ type: 'text', text }],
      toolCalls: [],
      origin: { kind: 'user' },
    },
    { admission: 'newTurn' },
  );
}

export interface EchoCall {
  readonly id: string;
  readonly turnId: number;
  readonly args: { readonly text: string };
}

export interface EchoTool extends ExecutableTool<{ readonly text: string }> {
  readonly calls: EchoCall[];
}

export function makeEchoTool(): EchoTool {
  const calls: EchoCall[] = [];
  const tool: ExecutableTool<{ readonly text: string }> = {
    name: 'echo',
    description: 'Echo back the input text.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
    resolveExecution: (input): ToolExecution => ({
      approvalRule: 'echo',
      execute: async (ctx): Promise<ExecutableToolResult> => {
        calls.push({ id: ctx.toolCallId, turnId: ctx.turnId, args: input });
        return { output: input.text };
      },
    }),
  };
  return Object.assign(tool, { calls });
}

/** A tool that blocks until released (or aborted) so tests can steer timing. */
export interface GatedTool extends ExecutableTool<Record<string, never>> {
  readonly started: Deferred<void>;
  readonly calls: Array<{ readonly id: string; readonly turnId: number }>;
  release(): void;
}

export function makeGatedTool(): GatedTool {
  const started = deferred<void>();
  const calls: Array<{ readonly id: string; readonly turnId: number }> = [];
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tool: ExecutableTool<Record<string, never>> = {
    name: 'gated',
    description: 'Blocks until the test releases it.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: (): ToolExecution => ({
      approvalRule: 'gated',
      execute: async (ctx): Promise<ExecutableToolResult> => {
        calls.push({ id: ctx.toolCallId, turnId: ctx.turnId });
        started.resolve();
        await gate;
        return { output: 'gated done' };
      },
    }),
  };
  return Object.assign(tool, { started, calls, release: () => release() });
}

/** Activate a tool through the profile and register it with the registry. */
export function registerTool(ctx: TestAgentContext, tool: ExecutableTool): void {
  ctx.get(IAgentToolRegistryService).register(tool);
  const profile = ctx.get(IAgentProfileService);
  const active = [...(profile.data().activeToolNames ?? [])];
  if (!active.includes(tool.name)) {
    profile.update({ activeToolNames: [...active, tool.name] });
  }
}

/** Loop-suite agent factory (plain `createTestAgent`). */
export function createLoopTestAgent(
  ...inputs: readonly (TestAgentServiceOverride | TestAgentOptions)[]
): TestAgentContext {
  return createTestAgent(...inputs);
}
