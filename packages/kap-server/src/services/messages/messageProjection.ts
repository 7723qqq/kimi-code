import {
  daemonFileRefFromPart,
  parseDaemonFileUrl,
  type ContentPart,
  type ContextMessage,
} from '@moonshot-ai/agent-core-v2';
import { projectPromptContentParts as projectTranscriptPromptContent } from '@moonshot-ai/transcript';

import type { Message, MessageContent, MessageRole, ToolUseContent } from '../../protocol/message';

function deriveMessageId(sessionId: string, index: number): string {
  const padded = String(index).padStart(6, '0');
  return `msg_${sessionId}_${padded}`;
}

function toProtocolRole(role: ContextMessage['role']): MessageRole {
  return role as MessageRole;
}

function mapContentPart(part: ContextMessage['content'][number]): MessageContent {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'think': {
      const sig = part.encrypted;
      return sig !== undefined
        ? { type: 'thinking', thinking: part.think, signature: sig }
        : { type: 'thinking', thinking: part.think };
    }
    case 'image_url': {
      const ref = parseDaemonFileUrl(part.imageUrl.url);
      return ref !== undefined
        ? {
            type: 'image',
            source: { kind: 'session_media', file_id: ref.fileId },
            name: part.imageUrl.name,
          }
        : {
            type: 'image',
            source: { kind: 'url', url: part.imageUrl.url, id: part.imageUrl.id },
            name: part.imageUrl.name,
          };
    }
    case 'audio_url':
      return { type: 'text', text: `[audio:${part.audioUrl.url}]` };
    case 'document_url': {
      const ref = parseDaemonFileUrl(part.documentUrl.url);
      return ref !== undefined
        ? {
            type: 'file',
            file_id: ref.fileId,
            name: part.documentUrl.name,
            media_type: part.documentUrl.mimeType,
          }
        : { type: 'text', text: `[document:${part.documentUrl.mimeType}]` };
    }
    case 'video_url': {
      const ref = parseDaemonFileUrl(part.videoUrl.url);
      return ref !== undefined
        ? {
            type: 'video',
            source: { kind: 'session_media', file_id: ref.fileId },
            name: part.videoUrl.name,
          }
        : {
            type: 'video',
            source: { kind: 'url', url: part.videoUrl.url, id: part.videoUrl.id },
            name: part.videoUrl.name,
          };
    }
  }
}

interface CoreMediaPart {
  readonly type: 'image_url' | 'audio_url' | 'video_url';
  readonly source:
    | { readonly kind: 'url'; readonly url: string }
    | { readonly kind: 'inline' | 'file' | 'store' };
}

function isCoreMediaPart(part: unknown): part is CoreMediaPart {
  if (typeof part !== 'object' || part === null || !('type' in part) || !('source' in part)) {
    return false;
  }
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') {
    return false;
  }
  const source = part.source;
  if (typeof source !== 'object' || source === null || !('kind' in source)) return false;
  return (
    source.kind === 'url' ||
    source.kind === 'inline' ||
    source.kind === 'file' ||
    source.kind === 'store'
  );
}

function projectToolResultMediaPart(part: unknown): unknown {
  if (isCoreMediaPart(part)) {
    if (part.source.kind !== 'url' || part.type === 'audio_url') return part;
    const ref = parseDaemonFileUrl(part.source.url);
    if (ref === undefined) return part;
    return {
      type: part.type === 'image_url' ? 'image' : 'video',
      source: { kind: 'session_media', file_id: ref.fileId },
      name: (part as { name?: unknown }).name,
    };
  }
  const legacy = part as ContentPart;
  if (typeof legacy !== 'object' || legacy === null) return legacy;
  const ref = daemonFileRefFromPart(legacy);
  if (ref === undefined) return legacy;
  if (legacy.type === 'image_url') {
    return {
      type: 'image',
      source: { kind: 'session_media', file_id: ref.ref.fileId },
      name: legacy.imageUrl.name,
    };
  }
  if (legacy.type === 'video_url') {
    return {
      type: 'video',
      source: { kind: 'session_media', file_id: ref.ref.fileId },
      name: legacy.videoUrl.name,
    };
  }
  return legacy;
}

export function projectToolResultOutput(output: unknown): unknown {
  if (!Array.isArray(output)) return output;
  return output.map((part) => projectToolResultMediaPart(part));
}

function buildProtocolContent(msg: ContextMessage): MessageContent[] {
  const visibleContent = msg.content.filter((p) => p.type !== 'think' || p.hidden !== true);
  if (msg.role === 'tool') {
    if (msg.toolCallId === undefined) {
      return visibleContent.map((p) => mapContentPart(p));
    }
    const hasMediaPart = visibleContent.some(
      (p) => p.type === 'image_url' || p.type === 'video_url' || p.type === 'audio_url',
    );
    const output: unknown = hasMediaPart
      ? projectToolResultOutput(visibleContent)
      : visibleContent.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const part: MessageContent =
      msg.isError === true
        ? {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output,
            is_error: true,
          }
        : {
            type: 'tool_result',
            tool_call_id: msg.toolCallId,
            output,
          };
    return [part];
  }

  const base = visibleContent.map((p) => mapContentPart(p));

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

export function projectPromptContentParts(content: readonly ContentPart[]): MessageContent[] {
  return projectTranscriptPromptContent(content) as MessageContent[];
}

export function toProtocolMessage(
  sessionId: string,
  index: number,
  msg: ContextMessage,
  sessionCreatedAtMs: number,
  createdAtMsOverride?: number,
): Message {
  const id = msg.id ?? deriveMessageId(sessionId, index);
  const role = toProtocolRole(msg.role);
  const content = buildProtocolContent(msg);
  const createdAtMs = createdAtMsOverride ?? sessionCreatedAtMs + index;
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
