import type { SwarmPlan } from './types';

/** Read-only default tool set for workers; planner may widen via toolAllowlist within the allowlist. */
export const DEFAULT_WORKER_TOOLS: readonly string[] = ['Read', 'Grep', 'Glob', 'WebSearch', 'FetchURL'];

/** Tool names a worker is allowed to request. Read-only for Phase 1 (no Write/Edit/Bash, no dispatch tools). */
export const ALLOWED_WORKER_TOOLS: readonly string[] = [
  'Read',
  'Grep',
  'Glob',
  'WebSearch',
  'FetchURL',
  'ReadMediaFile',
];

export const PLANNER_SYSTEM_PROMPT = [
  'You are a swarm planner. Decompose the user task into independent subtasks that can run in parallel.',
  'For each subtask invent a short role name, a focused system prompt for that role, and a concrete prompt.',
  'Optionally specify toolAllowlist (a subset of the allowed tools) when a subtask needs more than read-only access.',
  `Allowed tools: ${ALLOWED_WORKER_TOOLS.join(', ')}.`,
  'Output ONLY a JSON object, no prose, matching exactly:',
  '{"subtasks":[{"id":"task-1","role":"...","systemPrompt":"...","prompt":"...","toolAllowlist":["Read"]}]}',
  'Keep it to at most 6 subtasks. Each subtask must be self-contained (workers cannot see each other).',
].join('\n');

export function renderPlannerPrompt(rootTask: string): string {
  return `Task to decompose:\n${rootTask}\n\nReturn only the JSON plan.`;
}

export function renderPlannerRetryPrompt(rootTask: string, previous: string): string {
  return [
    `Task to decompose:\n${rootTask}`,
    '',
    'Your previous response was not valid JSON in the required shape:',
    previous.slice(0, 1000),
    '',
    'Return ONLY the JSON object, with a non-empty "subtasks" array. No prose, no code fences.',
  ].join('\n');
}

export const SYNTHESIZER_SYSTEM_PROMPT = [
  'You are a swarm synthesizer. You are given the original task and the outputs of several worker subagents.',
  'Merge them into one coherent, complete answer for the user.',
  'If a subtask failed, note the gap explicitly instead of inventing its content.',
].join('\n');

export function renderSynthesizerPrompt(plan: SwarmPlan): string {
  const blocks = plan.subtasks.map((st) => {
    const body =
      st.status === 'done' ? (st.result ?? '') : `[FAILED: ${st.error ?? 'unknown error'}]`;
    return `### ${st.role} (${st.status})\n${body}`;
  });
  return [`Original task:\n${plan.rootTask}`, '', 'Worker outputs:', '', ...blocks].join('\n');
}
