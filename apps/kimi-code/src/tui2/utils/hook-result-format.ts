/**
 * Format a `hook.result` event into markdown / plain-text transcript lines
 * (`*<title>*` + body) rendered when a user hook reports a result.
 *
 * Status: REAL (tui2). Self-contained; no v1 re-export.
 */

import type { Event } from '@moonshot-ai/kimi-code-sdk';

type HookResultEvent = Extract<Event, { type: 'hook.result' }>;

export function formatHookResultMarkdown(event: HookResultEvent): string {
  return `*${formatHookResultTitle(event)}*\n\n${formatHookResultBody(event)}`;
}

export function formatHookResultPlain(event: HookResultEvent): string {
  return `${formatHookResultTitle(event)}\n\n${formatHookResultBody(event)}`;
}

function formatHookResultTitle(event: HookResultEvent): string {
  return `${event.hookEvent} hook${event.blocked === true ? ' blocked' : ''}`;
}

function formatHookResultBody(event: HookResultEvent): string {
  const content = event.content.trim();
  return content.length === 0 ? '(empty)' : content;
}
