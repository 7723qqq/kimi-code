export interface Subtask {
  id: string;
  role: string;
  systemPrompt: string;
  prompt: string;
  toolAllowlist?: string[] | undefined;
  status: 'pending' | 'running' | 'done' | 'failed';
  result?: string | undefined;
  error?: string | undefined;
}

export interface SwarmPlan {
  rootTask: string;
  subtasks: Subtask[];
}

/** What the coordinator needs to run one subagent to completion. */
export type SpawnSubagentFn = (args: {
  profileName: string;
  systemPrompt: string;
  tools: string[];
  prompt: string;
  description: string;
  signal: AbortSignal;
}) => Promise<{ result: string }>;

export type SwarmProgress =
  | { phase: 'planned'; total: number }
  | { phase: 'synthesizing' }
  | { phase: 'done'; succeeded: number; failed: number };

export interface SwarmCoordinatorDeps {
  spawnSubagent: SpawnSubagentFn;
  signal: AbortSignal;
  onProgress?: ((text: string) => void) | undefined;
  onProgressCustom?: ((progress: SwarmProgress) => void) | undefined;
  maxConcurrency?: number | undefined;
  /**
   * Repeat count at which a worker that keeps issuing the SAME tool call is
   * treated as stalled and hard-stopped (its turn fails with a distinguishable
   * reason so this wave records it as a failed subtask). Defaults to
   * {@link DEFAULT_STALL_REPEAT_THRESHOLD}.
   */
  stallRepeatThreshold?: number | undefined;
}

/** Default repeat threshold for swarm worker stall detection. */
export const DEFAULT_STALL_REPEAT_THRESHOLD = 10;
