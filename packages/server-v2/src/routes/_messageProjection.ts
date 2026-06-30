/**
 * Shared projection from a v2 `ContextMessage` history entry to the wire
 * `Message` shape. Mirrors v1's `toProtocolMessage`
 * (`packages/agent-core/src/services/message/message.ts`) so both the
 * `/messages` routes and the `undo` session action produce byte-compatible
 * message objects.
 */

import type { IContextMemory } from '@moonshot-ai/agent-core-v2';
import type { Message, MessageContent, MessageRole, ToolUseContent } from '@moonshot-ai/protocol';

/** One entry from the main agent's live history. */
type MemoryMessage = ReturnType<IContextMemory['get']>[number];

/** Derive a stable opaque message id from (sessionId, index). */
function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

/**
 * Inverse of `deriveMessageId`: parse `msg_<sessionId>_<index>` back into
 * `{sessionId, index}`. Returns `undefined` when the id does not match the
 * derived contract. The session id may itself contain underscores, so the split
 * is taken from the RIGHT on `_`.
 */
export function parseMessageId(
  messageId: string,
): { sessionId: string; index: number } | undefined {
  if (!messageId.startsWith('msg_')) return undefined;
  const rest = messageId.slice('msg_'.length);
  const lastUnderscore = rest.lastIndexOf('_');
  if (lastUnderscore <= 0) return undefined;
  const sessionId = rest.slice(0, lastUnderscore);
  const indexStr = rest.slice(lastUnderscore + 1);
  if (!/^\d+$/.test(indexStr)) return undefined;
  const index = Number.parseInt(indexStr, 10);
  if (!Number.isFinite(index) || index < 0) return undefined;
  return { sessionId, index };
}

/** kosong's `Role` already matches the wire `MessageRole` — pass through. */
function toProtocolRole(role: MemoryMessage['role']): MessageRole {
  return role as MessageRole;
}

/** Translate one kosong content part to a wire content part. */
function mapContentPart(part: MemoryMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url':
      return {
        type: 'image',
        source: { kind: 'url', url: part.imageUrl.url },
      };
    case 'audio_url':
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'video_url':
      return { type: 'text', text: `[video:${part.videoUrl.url}]` };
  }
}

/**
 * Build the protocol-shaped `Message.content[]` for one history entry:
 *   1. `tool` role → a single `tool_result` part.
 *   2. other roles → each mapped content part, then one `tool_use` part per
 *      `ToolCall` (assistant only).
 */
function buildProtocolContent(msg: MemoryMessage): MessageContent[] {
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      return msg.content.map((p) => mapContentPart(p));
    }
    const flattenedOutput = msg.content
      .map((p) => (p.type === 'text' ? p.text : ''))
      .join('');
    const part: MessageContent =
      msg.isError === true
        ? {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output: flattenedOutput,
            is_error: true,
          }
        : {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output: flattenedOutput,
          };
    return [part];
  }

  const base = msg.content.map((p) => mapContentPart(p));

  if (msg.role === 'assistant' && msg.toolCalls.length > 0) {
    for (const call of msg.toolCalls) {
      let parsedInput: unknown = call.arguments;
      if (typeof call.arguments === 'string') {
        try {
          parsedInput = JSON.parse(call.arguments);
        } catch {
          parsedInput = call.arguments;
        }
      }
      const part: ToolUseContent = {
        type: 'tool_use',
        tool_call_id: call.id,
        tool_name: call.name,
        input: parsedInput,
      };
      base.push(part);
    }
  }

  return base;
}

/**
 * Convert one history entry into the protocol's `Message` shape. `created_at`
 * is synthesized from the session's `createdAt` plus the entry index so it
 * increases monotonically across the array.
 */
export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: MemoryMessage,
  sessionCreatedAtMs: number,
): Message {
  const id = deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = sessionCreatedAtMs + index;
  const metadata = msg.origin !== undefined ? { origin: msg.origin } : undefined;
  return {
    id,
    session_id: sessionId,
    role,
    content,
    created_at: new Date(createdAtMs).toISOString(),
    ...(metadata !== undefined ? { metadata } : {}),
  };
}
