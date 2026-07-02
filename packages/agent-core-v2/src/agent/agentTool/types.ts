/**
 * `agentTool` domain (L5) — child-agent run contract types.
 *
 * Leaf module holding the option/handle types shared by the `runChildAgent`
 * helpers and the `subagentBatch` scheduler. Owns no scoped state and imports
 * no business domain, so it sits below both modules and breaks their import
 * cycle.
 */

import type { TokenUsage } from '#/app/llmProtocol';

export const DEFAULT_SUBAGENT_TIMEOUT_MS = 30 * 60 * 1000;
export const DEFAULT_SUBAGENT_TIMEOUT_DESCRIPTION = '30 minutes';

export interface RunSubagentOptions {
  readonly parentToolCallId: string;
  readonly parentToolCallUuid?: string;
  readonly prompt: string;
  readonly description: string;
  readonly swarmIndex?: number;
  readonly runInBackground: boolean;
  readonly signal: AbortSignal;
  readonly onReady?: () => void;
  readonly suppressRateLimitFailureEvent?: boolean;
}

export interface SpawnSubagentOptions extends RunSubagentOptions {
  readonly profileName: string;
  readonly swarmItem?: string;
}

export type SubagentHandle = {
  readonly agentId: string;
  readonly profileName: string;
  readonly resumed: boolean;
  readonly completion: Promise<{
    readonly result: string;
    readonly usage?: TokenUsage;
  }>;
};
