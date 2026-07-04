/**
 * `contextMemory` message id helpers.
 *
 * Every `ContextMessage` gets a stable local id (`msg_<ulid>`) when it enters
 * `IAgentContextMemoryService`. The id is persisted in context operation wire
 * records, so it is stable across restarts. It is the identity used for message
 * lookup, snapshot correlation, and replay-record removal. Provider-assigned ids
 * live on the separate `providerMessageId` field and never collide with this
 * namespace.
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
