import type { z } from 'zod';

import { createDecorator } from '#/_base/di/instantiation';
import { type AgentTool } from '#/tool/toolContract';

export interface GitHubToolSpec<Input extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: Input;
  readonly method: string;
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
