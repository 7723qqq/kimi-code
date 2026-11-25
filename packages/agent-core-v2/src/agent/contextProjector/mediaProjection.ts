import { createHash } from 'node:crypto';
import type { Message } from '#/llm-adapter/contract/message';
import {
  mediaOmissionOf,
  omitMediaPart,
  type ContentPart,
  type MediaPart as CoreMediaPart,
  type MediaPlaceholderReason,
} from '@moonshot-ai/core/llm/message';

import type { MediaStripSnapshot } from './contextProjector';

type MediaPart = Extract<ContentPart, { readonly type: 'image_url' | 'audio_url' | 'video_url' }>;

interface MediaContainer {
  readonly url: string;
  readonly id?: string;
}

interface MediaStripSnapshotData {
  readonly keys: ReadonlySet<string>;
}

type MediaContainerKeyCache = Partial<Record<MediaPart['type'], string>>;

const MEDIA_CONTAINER_KEY_CACHE = new WeakMap<MediaContainer, MediaContainerKeyCache>();

function isDegradableMediaPart(part: ContentPart): part is MediaPart {
  return (
    (part.type === 'image_url' || part.type === 'audio_url' || part.type === 'video_url') &&
    mediaOmissionOf(part as CoreMediaPart) === undefined
  );
}

function markOmitted(part: MediaPart, reason: MediaPlaceholderReason): ContentPart {
  return omitMediaPart(part as CoreMediaPart, reason) as ContentPart;
}

function mediaContainer(part: MediaPart): MediaContainer {
  if (part.type === 'image_url') return part.imageUrl;
  if (part.type === 'audio_url') return part.audioUrl;
  return part.videoUrl;
}

function mediaStripKey(part: MediaPart): string {
  const container = mediaContainer(part);
  let cache = MEDIA_CONTAINER_KEY_CACHE.get(container);
  const cached = cache?.[part.type];
  if (cached !== undefined) return cached;

  const key = createHash('sha256')
    .update(part.type)
    .update('\0')
    .update(container.id ?? '')
    .update('\0')
    .update(container.url)
    .digest('hex');
  if (cache === undefined) {
    cache = {};
    MEDIA_CONTAINER_KEY_CACHE.set(container, cache);
  }
  cache[part.type] = key;
  return key;
}

function mediaStripSnapshotKeys(snapshot: MediaStripSnapshot): ReadonlySet<string> {
  return (snapshot as unknown as MediaStripSnapshotData).keys;
}

export function captureMediaStripSnapshot(messages: readonly Message[]): MediaStripSnapshot {
  const keys = new Set<string>();
  for (const message of messages) {
    for (const part of message.content) {
      if (isDegradableMediaPart(part)) keys.add(mediaStripKey(part));
    }
  }
  return Object.freeze({ keys }) as unknown as MediaStripSnapshot;
}

export function stripMediaPartsBySnapshot(
  messages: readonly Message[],
  snapshot: MediaStripSnapshot,
): readonly Message[] {
  const keys = mediaStripSnapshotKeys(snapshot);
  let changed = false;
  const result = messages.map((message) => {
    let messageChanged = false;
    const content = message.content.map((part): ContentPart => {
      if (!isDegradableMediaPart(part) || !keys.has(mediaStripKey(part))) return part;
      changed = true;
      messageChanged = true;
      return markOmitted(part, 'stripped');
    });
    return messageChanged ? { ...message, content } : message;
  });
  return changed ? result : messages;
}

export function countMediaParts(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) => count + message.content.filter(isDegradableMediaPart).length,
    0,
  );
}

export function degradeLeadingMediaParts(
  messages: readonly Message[],
  count: number,
): readonly Message[] {
  let toDegrade = count;
  if (toDegrade <= 0) return messages;

  return messages.map((message) => {
    if (toDegrade === 0 || !message.content.some(isDegradableMediaPart)) return message;
    const content = message.content.map((part): ContentPart => {
      if (toDegrade === 0 || !isDegradableMediaPart(part)) return part;
      toDegrade -= 1;
      return markOmitted(part, 'degraded');
    });
    return { ...message, content };
  });
}
