import { daemonFileRefFromPairingPart } from './mediaRef';

export interface PromptContentInputPart {
  readonly type: string;
  readonly text?: string;
  readonly meta?: { readonly source?: string; readonly [key: string]: unknown };
  readonly imageUrl?: { readonly url?: string; readonly name?: string; readonly id?: string };
  readonly videoUrl?: { readonly url?: string; readonly name?: string; readonly id?: string };
}

export type PromptContentSource =
  | { readonly kind: 'url'; readonly url: string; readonly id?: string }
  | { readonly kind: 'base64'; readonly media_type: string; readonly data: string }
  | { readonly kind: 'session_media'; readonly file_id: string };

export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly source: PromptContentSource; readonly name?: string }
  | { readonly type: 'video'; readonly source: PromptContentSource; readonly name?: string };

export function projectPromptContentParts(
  content: readonly PromptContentInputPart[],
): readonly PromptContentPart[] {
  const parts: PromptContentPart[] = [];
  for (const part of content) {
    const daemonRef = daemonFileRefFromPairingPart(part);
    if (daemonRef !== undefined) {
      parts.push({
        type: daemonRef.kind,
        source: { kind: 'session_media', file_id: daemonRef.ref.fileId },
        name:
          part.type === 'image_url'
            ? part.imageUrl?.name
            : part.type === 'video_url'
              ? part.videoUrl?.name
              : undefined,
      });
      continue;
    }
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text ?? '' });
      continue;
    }
    if (part.type === 'image_url') {
      const url = part.imageUrl?.url ?? '';
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      parts.push(
        match === null
          ? {
              type: 'image',
              source: { kind: 'url', url, id: part.imageUrl?.id },
              name: part.imageUrl?.name,
            }
          : {
              type: 'image',
              source: { kind: 'base64', media_type: match[1]!, data: match[2]! },
              name: part.imageUrl?.name,
            },
      );
      continue;
    }
    if (part.type === 'video_url') {
      const url = part.videoUrl?.url ?? '';
      const match = /^data:([^;]+);base64,(.*)$/.exec(url);
      parts.push(
        match === null
          ? {
              type: 'video',
              source: { kind: 'url', url, id: part.videoUrl?.id },
              name: part.videoUrl?.name,
            }
          : {
              type: 'video',
              source: { kind: 'base64', media_type: match[1]!, data: match[2]! },
              name: part.videoUrl?.name,
            },
      );
    }
  }
  return parts;
}
