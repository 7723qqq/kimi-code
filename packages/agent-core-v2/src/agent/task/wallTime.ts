export interface AgentTaskTiming {
  readonly startedAt: number;
  readonly endedAt: number | null;
}

export function formatTaskWallTime(task: AgentTaskTiming, nowMs: number = Date.now()): string {
  const durationMs = Math.max(0, (task.endedAt ?? nowMs) - task.startedAt);
  return `${(durationMs / 1000).toFixed(3)} seconds`;
}
