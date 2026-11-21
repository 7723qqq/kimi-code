import type { Message } from '#/llm-adapter/contract/message';

function byteLength(value: string | null | undefined): number {
  return value === null || value === undefined ? 0 : Buffer.byteLength(value, 'utf8');
}

export function estimateLlmRequestBytes(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) {
    for (const part of message.content) {
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
