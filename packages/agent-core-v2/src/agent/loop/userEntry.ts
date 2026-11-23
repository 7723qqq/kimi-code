import type { UserMessage } from '@moonshot-ai/core/llm/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';

export interface LoopUserEntryMeta {
  readonly origin?: PromptOrigin;
  readonly promptId?: string;
  readonly tracked?: boolean;
}

export interface LoopUserEntry {
  readonly message: UserMessage;
  readonly meta?: LoopUserEntryMeta;
}

export interface LoopUserAttributes {
  readonly origin?: PromptOrigin;
  readonly promptId?: string;
  readonly tracked?: boolean;
}

export function loopUserAttributes(message: { readonly attributes?: unknown }): LoopUserAttributes {
  return (message.attributes ?? {}) as LoopUserAttributes;
}

export function loopUserEntry(input: LoopUserEntry): UserMessage {
  const { message, meta } = input;
  const attributes: Record<string, unknown> = {};
  Object.assign(attributes, message.attributes);
  if (meta !== undefined) {
    attributes['origin'] = meta.origin ?? { kind: 'user' };
    if (meta.promptId !== undefined) attributes['promptId'] = meta.promptId;
    if (meta.tracked !== undefined) attributes['tracked'] = meta.tracked;
  }
  return Object.keys(attributes).length === 0
    ? { role: 'user', content: message.content }
    : { role: 'user', content: message.content, attributes: attributes as UserMessage['attributes'] };
}
