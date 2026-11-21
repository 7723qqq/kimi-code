import type { Message, TextPart } from '#human/message';
import type { DocumentURLPart } from '#human/message';
import { SyntaxRequestFormatError } from '#human/llm/syntax-errors';

import type { GoogleContent, GooglePart } from './contract';

function toolCallIdToName(toolCallId: string, toolNameById: Map<string, string>): string {
  const name = toolNameById.get(toolCallId);
  if (name !== undefined) return name;
  const withoutEntropy = toolCallId.replace(/_[0-9a-f]{8}$/, '');
  const match = /^(.+)_[^_]+$/.exec(withoutEntropy);
  return match?.[1] ?? withoutEntropy;
}

function convertMediaUrl(
  url: string,
  fallbackMimeType: string,
):
  | { inlineData: { mimeType: string; data: string } }
  | { fileData: { fileUri: string; mimeType: string } } {
  if (url.startsWith('data:')) {
    const commaIndex = url.indexOf(',');
    if (commaIndex === -1) {
      return { fileData: { fileUri: url, mimeType: fallbackMimeType } };
    }
    const meta = url.slice(0, commaIndex);
    const data = url.slice(commaIndex + 1);
    const colonIndex = meta.indexOf(':');
    const semiIndex = meta.indexOf(';');
    const mimeType =
      colonIndex !== -1 && semiIndex !== -1
        ? meta.slice(colonIndex + 1, semiIndex)
        : fallbackMimeType;
    return { inlineData: { mimeType, data } };
  }
  let mimeType = fallbackMimeType;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    if (pathname.endsWith('.png')) mimeType = 'image/png';
    else if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) mimeType = 'image/jpeg';
    else if (pathname.endsWith('.gif')) mimeType = 'image/gif';
    else if (pathname.endsWith('.webp')) mimeType = 'image/webp';
    else if (pathname.endsWith('.mp3') || pathname.endsWith('.mpeg')) mimeType = 'audio/mpeg';
    else if (pathname.endsWith('.wav')) mimeType = 'audio/wav';
    else if (pathname.endsWith('.ogg')) mimeType = 'audio/ogg';
  } catch {}
  return { fileData: { fileUri: url, mimeType } };
}

export function buildToolNameById(messages: readonly Message[]): Map<string, string> {
  const toolNameById = new Map<string, string>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.toolCalls) {
      toolNameById.set(toolCall.id, toolCall.name);
    }
  }
  return toolNameById;
}

export function buildRawIdById(messages: readonly Message[]): Map<string, string | undefined> {
  const rawIdById = new Map<string, string | undefined>();
  for (const message of messages) {
    if (message.role !== 'assistant') continue;
    for (const toolCall of message.toolCalls) {
      rawIdById.set(toolCall.id, toolCall.rawId);
    }
  }
  return rawIdById;
}

export interface GoogleGenAILowerContext {
  readonly toolNameById: Map<string, string>;
  readonly rawIdById: Map<string, string | undefined>;
  readonly modernFunctionResponses: boolean;
}

const FUNCTION_RESPONSE_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'application/pdf',
  'text/plain',
]);

function mediaMimeOf(part: GooglePart): string | undefined {
  return part.inlineData?.mimeType.toLowerCase();
}

export function lowerMessage(message: Message, lower: GoogleGenAILowerContext): GoogleContent[] {
  const { toolNameById, rawIdById, modernFunctionResponses } = lower;
  if (message.role === 'tool') {
    let textOutput = '';
    const mediaParts: GooglePart[] = [];
    for (const part of message.content as readonly (typeof message.content)[number][] | readonly DocumentURLPart[]) {
      switch (part.type) {
        case 'text':
          if (part.text) textOutput += part.text;
          break;
        case 'image_url':
          mediaParts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
          break;
        case 'audio_url':
          mediaParts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
          break;
        case 'video_url':
          mediaParts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
          break;
        case 'document_url':
          mediaParts.push(convertMediaUrl(part.documentUrl.url, part.documentUrl.mimeType));
          break;
        case 'think':
          break;
      }
    }
    const nestedParts = modernFunctionResponses
      ? mediaParts.filter((part) => {
          const mime = mediaMimeOf(part);
          return mime !== undefined && FUNCTION_RESPONSE_MIME_TYPES.has(mime);
        })
      : [];
    return [
      {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: rawIdById.get(message.toolCallId),
              name: toolCallIdToName(message.toolCallId, toolNameById),
              response: { output: textOutput },
              parts: nestedParts.length > 0 ? nestedParts : undefined,
            },
          },
          ...mediaParts.filter((part) => !nestedParts.includes(part)),
        ],
      },
    ];
  }

  if (message.role === 'system') {
    const text = message.content
      .filter((part): part is TextPart => part.type === 'text')
      .map((part) => part.text)
      .join('\n');
    if (text.length === 0) return [];
    return [
      {
        role: 'user',
        parts: [{ text: `<system>${text}</system>` }],
      },
    ];
  }

  const role = message.role === 'assistant' ? 'model' : 'user';
  const parts: GooglePart[] = [];
  for (const part of message.content as readonly (typeof message.content)[number][] | readonly DocumentURLPart[]) {
    switch (part.type) {
      case 'text': {
        const signature =
          message.role === 'assistant' ? part.meta?.['thought_signature_b64'] : undefined;
        parts.push({
          text: part.text,
          thoughtSignature:
            typeof signature === 'string' && signature.length > 0 ? signature : undefined,
        });
        break;
      }
      case 'think': {
        const thoughtPart: GooglePart = { text: part.think, thought: true };
        if (part.encrypted !== undefined && part.encrypted.length > 0) {
          thoughtPart.thoughtSignature = part.encrypted;
        }
        parts.push(thoughtPart);
        break;
      }
      case 'image_url':
        parts.push(convertMediaUrl(part.imageUrl.url, 'image/jpeg'));
        break;
      case 'audio_url':
        parts.push(convertMediaUrl(part.audioUrl.url, 'audio/mpeg'));
        break;
      case 'video_url':
        parts.push(convertMediaUrl(part.videoUrl.url, 'video/mp4'));
        break;
      case 'document_url':
        parts.push(convertMediaUrl(part.documentUrl.url, part.documentUrl.mimeType));
        break;
    }
  }

  if (message.role === 'assistant') {
    for (const toolCall of message.toolCalls) {
      let args: Record<string, unknown> = {};
      if (toolCall.arguments) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(toolCall.arguments);
        } catch {
          throw new SyntaxRequestFormatError('Tool call arguments must be valid JSON.');
        }
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
          throw new SyntaxRequestFormatError('Tool call arguments must be a JSON object.');
        }
        args = parsed as Record<string, unknown>;
      }

      const functionCallPart: GooglePart = {
        functionCall: {
          id: rawIdById.get(toolCall.id),
          name: toolCall.name,
          args,
        },
      };

      if (toolCall.extras && 'thought_signature_b64' in toolCall.extras) {
        functionCallPart['thoughtSignature'] = toolCall.extras['thought_signature_b64'] as string;
      }

      parts.push(functionCallPart);
    }
  }

  return [{ role, parts }];
}
