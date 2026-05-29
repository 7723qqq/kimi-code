import type { SwarmPlan, Subtask } from './types';

export function extractJsonObject(text: string): string | null {
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const candidate = fence?.[1] ?? text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end < start) return null;
  return candidate.slice(start, end + 1);
}

export function parsePlan(rootTask: string, text: string): SwarmPlan | null {
  const json = extractJsonObject(text);
  if (json === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;

  const subtasksRaw = (parsed as { subtasks?: unknown }).subtasks;
  if (!Array.isArray(subtasksRaw) || subtasksRaw.length === 0) return null;

  const subtasks: Subtask[] = [];
  for (let i = 0; i < subtasksRaw.length; i += 1) {
    const raw = subtasksRaw[i];
    if (typeof raw !== 'object' || raw === null) return null;
    const o = raw as Record<string, unknown>;
    if (
      typeof o['role'] !== 'string' ||
      typeof o['systemPrompt'] !== 'string' ||
      typeof o['prompt'] !== 'string'
    ) {
      return null;
    }
    const toolAllowlist = Array.isArray(o['toolAllowlist'])
      ? o['toolAllowlist'].filter((t): t is string => typeof t === 'string')
      : undefined;
    subtasks.push({
      id: typeof o['id'] === 'string' && o['id'].length > 0 ? o['id'] : `task-${String(i + 1)}`,
      role: o['role'],
      systemPrompt: o['systemPrompt'],
      prompt: o['prompt'],
      toolAllowlist,
      status: 'pending',
    });
  }
  return { rootTask, subtasks };
}
