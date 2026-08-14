/**
 * `codeRuntime` domain — `IRunCodeTool` contract (the `run_code` tool).
 *
 * The model-facing surface of the Code Mode capability: runs one
 * model-written TypeScript/JavaScript program in an isolated worker thread
 * and reports its console output, completion value, or failure. The public
 * input schema, the tool DI decorator, and the runtime result contract.
 * Bound at Agent scope.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export const RunCodeInputSchema = z.object({
  code: z
    .string()
    .min(1)
    .describe(
      'The TypeScript/JavaScript program to run. The body executes as an async function, so top-level await and return work. console.log/info/warn/error/debug output is captured.',
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1_000)
    .max(120_000)
    .default(30_000)
    .describe('Execution budget in milliseconds before the worker is terminated (default 30000).'),
});

export interface RunCodeInput {
  code: string;
  timeout_ms: number;
}

export interface CodeRunOutcome {
  /** Captured console output lines, in emission order. */
  readonly logs: readonly string[];
  /** The program's completion value, when it is JSON-serializable. */
  readonly value?: unknown;
  /** Program failure (exception / invalid-output / output-limit / timeout / cancelled / worker-error). */
  readonly error?: { readonly kind: string; readonly message: string };
}

export interface IRunCodeTool extends AgentTool<RunCodeInput> {
  readonly _serviceBrand: undefined;
}
export const IRunCodeTool = createDecorator<IRunCodeTool>('runCodeTool');
