/**
 * `tools` domain — GitHub tool contract.
 *
 * Defines the `IGitHubTool` service interface implemented by every built-in
 * GitHub REST tool, and the `GitHubToolSpec` table shape that drives the tool
 * factory in `github-tools.ts`. A spec declares the LLM-facing zod schema, the
 * endpoint (method + path + query/body builders), and the approval-rule
 * subject. No scoped service.
 */

import { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export interface GitHubToolSpec<Input extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: Input;
  readonly method: string;
  // The table is an array of mixed schemas, so the builders receive the
  // inferred input (opaque in the shared-array case) and re-narrow it via the
  // schema's `safeParse` in the base class.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly path: (args: z.infer<Input>) => string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly query?: (args: z.infer<Input>) => Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly body?: (args: z.infer<Input>) => unknown;
  readonly accept?: string;
  /** Mutating tools are omitted from the auto-approve allowlist (they prompt). */
  readonly mutating?: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly subject: (args: z.infer<Input>) => string;
}

export interface IGitHubTool extends AgentTool {
  readonly _serviceBrand: undefined;
}

export const IGitHubTool = createDecorator<IGitHubTool>('gitHubTool');
