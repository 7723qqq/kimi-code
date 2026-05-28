import type { Event } from '@moonshot-ai/kimi-code-sdk';

export function getDebugLevel(): number {
  const raw = process.env['KIMI_CODE_DEBUG'];
  if (raw === '1') return 1;
  if (raw === '2') return 2;
  return 0;
}

export function isDebugEnabled(): boolean {
  return getDebugLevel() >= 1;
}

export function isRpcDebugEnabled(): boolean {
  return getDebugLevel() >= 2;
}

type EventLike = { readonly type: string } & Record<string, unknown>;

const MAX_STRING = 60;
const MAX_JSON = 100;

export function formatDebugEvent(event: Event | EventLike, now: Date = new Date()): string {
  const e = event as EventLike;
  const parts: string[] = [];

  pushTurnContext(e, parts);
  pushTypeSpecific(e, parts);

  const suffix = parts.length === 0 ? '' : ` (${parts.join(', ')})`;
  return `RPC Event: ${e.type}${suffix} @ ${formatClock(now)}`;
}

function pushTurnContext(e: EventLike, parts: string[]): void {
  // Events with a step-level context: show turn + step first.
  if (typeof e['turnId'] === 'number' && hasOwn(e, 'step')) {
    parts.push(`turn=${e['turnId']}`);
    if (typeof e['step'] === 'number') parts.push(`step=${e['step']}`);
    return;
  }
  // Turn-level only.
  if (typeof e['turnId'] === 'number') {
    parts.push(`turn=${e['turnId']}`);
  }
}

function pushTypeSpecific(e: EventLike, parts: string[]): void {
  switch (e.type) {
    case 'turn.started':
      if (typeof e['origin'] === 'string') parts.push(`origin=${e['origin']}`);
      return;
    case 'turn.ended':
      if (typeof e['reason'] === 'string') parts.push(`reason=${e['reason']}`);
      return;
    case 'turn.step.completed':
      if (typeof e['finishReason'] === 'string') parts.push(`finish=${e['finishReason']}`);
      return;
    case 'turn.step.interrupted':
      if (typeof e['reason'] === 'string') parts.push(`reason=${e['reason']}`);
      return;
    case 'turn.step.retrying':
      if (typeof e['nextAttempt'] === 'number' && typeof e['maxAttempts'] === 'number') {
        parts.push(`attempt=${e['nextAttempt']}/${e['maxAttempts']}`);
      }
      if (typeof e['delayMs'] === 'number') parts.push(`delay=${e['delayMs']}ms`);
      if (typeof e['errorName'] === 'string') parts.push(`error=${e['errorName']}`);
      return;
    case 'hook.result':
      if (typeof e['hookEvent'] === 'string') parts.push(`hook=${e['hookEvent']}`);
      if (e['blocked'] === true || e['blocked'] === false) parts.push(`blocked=${e['blocked']}`);
      return;
    case 'tool.call.started':
      if (typeof e['name'] === 'string') parts.push(`tool=${e['name']}`);
      if (typeof e['toolCallId'] === 'string') parts.push(`id=${e['toolCallId']}`);
      if (hasOwn(e, 'args')) parts.push(`args=${jsonish(e['args'])}`);
      return;
    case 'tool.progress':
      if (typeof e['toolCallId'] === 'string') parts.push(`id=${e['toolCallId']}`);
      {
        const update = e['update'];
        if (isRecord(update) && typeof update['kind'] === 'string') {
          parts.push(`kind=${update['kind']}`);
        }
      }
      return;
    case 'tool.result':
      if (typeof e['toolCallId'] === 'string') parts.push(`id=${e['toolCallId']}`);
      if (e['isError'] === true || e['isError'] === false) parts.push(`error=${e['isError']}`);
      return;
    case 'skill.activated':
      if (typeof e['skillName'] === 'string') parts.push(`skill=${e['skillName']}`);
      if (typeof e['trigger'] === 'string') parts.push(`trigger=${e['trigger']}`);
      return;
    case 'agent.status.updated':
      if (typeof e['model'] === 'string') parts.push(`model=${e['model']}`);
      if (typeof e['contextTokens'] === 'number' && typeof e['maxContextTokens'] === 'number') {
        parts.push(`ctx=${e['contextTokens']}/${e['maxContextTokens']}`);
      } else if (typeof e['contextTokens'] === 'number') {
        parts.push(`ctx=${e['contextTokens']}`);
      }
      return;
    case 'session.meta.updated':
      if (typeof e['title'] === 'string') parts.push(`title=${quote(e['title'])}`);
      return;
    case 'error':
    case 'warning':
      if (typeof e['code'] === 'string') parts.push(`code=${e['code']}`);
      if (typeof e['message'] === 'string') parts.push(`message=${quote(e['message'])}`);
      return;
    case 'subagent.spawned':
      if (typeof e['subagentId'] === 'string') parts.push(`subagent=${e['subagentId']}`);
      if (typeof e['subagentName'] === 'string') parts.push(`name=${e['subagentName']}`);
      if (e['runInBackground'] === true || e['runInBackground'] === false) {
        parts.push(`bg=${e['runInBackground']}`);
      }
      return;
    case 'subagent.completed':
      if (typeof e['subagentId'] === 'string') parts.push(`subagent=${e['subagentId']}`);
      return;
    case 'subagent.failed':
      if (typeof e['subagentId'] === 'string') parts.push(`subagent=${e['subagentId']}`);
      if (typeof e['error'] === 'string') parts.push(`error=${quote(e['error'])}`);
      return;
    case 'compaction.started':
      if (typeof e['trigger'] === 'string') parts.push(`trigger=${e['trigger']}`);
      return;
    case 'compaction.completed': {
      const result = e['result'];
      if (isRecord(result)) {
        if (typeof result['compactedCount'] === 'number') {
          parts.push(`compacted=${result['compactedCount']}`);
        }
        if (
          typeof result['tokensBefore'] === 'number' &&
          typeof result['tokensAfter'] === 'number'
        ) {
          parts.push(`tokens=${result['tokensBefore']}->${result['tokensAfter']}`);
        }
      }
      return;
    }
    case 'background.task.started':
    case 'background.task.updated':
    case 'background.task.terminated': {
      const info = e['info'];
      if (isRecord(info)) {
        if (typeof info['taskId'] === 'string') parts.push(`task=${info['taskId']}`);
        if (typeof info['status'] === 'string') parts.push(`status=${info['status']}`);
      }
      return;
    }
    case 'tool.list.updated':
      if (typeof e['reason'] === 'string') parts.push(`reason=${e['reason']}`);
      if (typeof e['serverName'] === 'string') parts.push(`server=${e['serverName']}`);
      return;
    case 'mcp.server.status': {
      const server = e['server'];
      if (isRecord(server)) {
        if (typeof server['name'] === 'string') parts.push(`server=${server['name']}`);
        if (typeof server['status'] === 'string') parts.push(`status=${server['status']}`);
      }
      return;
    }
  }
}

function quote(s: string, max = MAX_STRING): string {
  const oneLine = s.replaceAll('\n', '\\n');
  const clipped = oneLine.length > max ? `${oneLine.slice(0, max)}...` : oneLine;
  return `"${clipped}"`;
}

function jsonish(v: unknown, max = MAX_JSON): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = String(v);
  }
  s = s.replaceAll('\n', '\\n');
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function hasOwn(obj: EventLike, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function formatClock(d: Date): string {
  const pad = (n: number, w = 2): string => n.toString().padStart(w, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

/**
 * Suppresses repeated high-frequency streaming delta events so debug output
 * shows only the first occurrence of each stream.
 */
export class DebugEventTracker {
  shouldEmit(event: Event | EventLike): boolean {
    switch ((event as EventLike).type) {
      case 'assistant.delta':
      case 'thinking.delta':
      case 'tool.call.delta':
        return false;
      default:
        return true;
    }
  }

  reset(): void {
    // Reserved for future per-session state.
  }
}
