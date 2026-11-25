import type { Message } from '#/llm-adapter/contract/message';
import {
  mediaKindOfPart,
  mediaOmissionOf,
  mediaPlaceholderText,
} from '@moonshot-ai/core/llm/message';
import type { ContentPart } from '#human/llm/message';

function byteLength(value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
}

function omittedMediaBytes(part: ContentPart): number | undefined {
  if (part.type !== 'image_url' && part.type !== 'audio_url' && part.type !== 'video_url') {
    return undefined;
  }
  const omitted = mediaOmissionOf(part);
  if (omitted === undefined) return undefined;
  return byteLength(mediaPlaceholderText(mediaKindOfPart(part), omitted));
}

export function estimateLlmRequestBytes(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.content) {
      const omitted = omittedMediaBytes(part);
      if (omitted !== undefined) {
        total += omitted;
        continue;
      }
      if (part.type === 'text') total += byteLength(part.text);
      else if (part.type === 'think') {
        total += byteLength(part.think) + byteLength(part.encrypted);
      } else if (part.type === 'image_url') total += byteLength(part.imageUrl.url);
      else if (part.type === 'audio_url') total += byteLength(part.audioUrl.url);
      else if (part.type === 'video_url') total += byteLength(part.videoUrl.url);
    }
    for (const call of message.toolCalls) total += byteLength(call.arguments);
  }
  return total;
}
