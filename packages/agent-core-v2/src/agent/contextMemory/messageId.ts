/**
 * `contextMemory` message id helpers.
 *
 * Every `ContextMessage` gets a stable local id (`msg_<ulid>`) when it enters
 * `IAgentContextMemoryService` — see `AgentContextMemoryService.splice`. The id is persisted in
 * the `context.splice` wire record, so it is stable across restarts. It is the
 * identity used by `Turn.promptMessageId`, snapshot `current_prompt_id`, and
 * message lookup. Provider-assigned ids live on the separate
 * `providerMessageId` field and never collide with this namespace.
 */

import { ulid } from 'ulid';

import type { ContextMessage } from './types';

/** Allocate a fresh local message id (`msg_<ulid>`). */
export function newMessageId(): string {
  return `msg_${ulid()}`;
}

/** Return `message` with an `id`, stamping a fresh one only when absent. Idempotent. */
export function ensureMessageId(message: ContextMessage): ContextMessage {
  return message.id !== undefined ? message : { ...message, id: newMessageId() };
}
