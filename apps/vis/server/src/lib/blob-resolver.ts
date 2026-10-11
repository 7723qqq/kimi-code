import type { ContentPart, WireEntry } from './agent-record-types';

const BLOBREF_PROTOCOL = 'blobref:';

function isBlobRef(url: string): boolean {
  return url.startsWith(BLOBREF_PROTOCOL);
}

/** Convert a `blobref:<mime>;<hash>` URL into a vis-server blob route.
 *  Non-blobref URLs are returned unchanged. */
export function resolveBlobRefUrl(
  url: string,
  sessionId: string,
  agentId: string,
  baseUrl: string = '',
): string {
  if (!isBlobRef(url)) return url;
  const rest = url.slice(BLOBREF_PROTOCOL.length);
  const semiIdx = rest.indexOf(';');
  if (semiIdx === -1) return url;
  const mimeType = rest.slice(0, semiIdx);
  const hash = rest.slice(semiIdx + 1);
  if (hash.length === 0) return url;
  const path = `/api/sessions/${encodeURIComponent(sessionId)}/blobs/${encodeURIComponent(hash)}?agent=${encodeURIComponent(agentId)}&mime=${encodeURIComponent(mimeType)}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

/** Walk every record in a wire and replace blobref URLs with vis-server
 *  blob routes so the UI can render them. Only mutates `entry.data`;
 *  `entry.raw` is left untouched. Malformed parts are left as-is and their
 *  line number is appended to `warnings`, matching the wire-reader policy of
 *  surfacing bad data instead of failing the whole page. */
export function rehydrateWireEntries(
  entries: readonly WireEntry[],
  sessionId: string,
  agentId: string,
  baseUrl: string = '',
  warnings?: string[],
): void {
  for (const entry of entries) {
    rehydrateRecord(entry.data as Record<string, unknown>, sessionId, agentId, baseUrl, warnings);
  }
}

function warnMalformed(warnings: string[] | undefined, what: string): void {
  warnings?.push(`malformed ${what}: part left unresolved`);
}

function rehydrateRecord(
  record: Record<string, unknown>,
  sessionId: string,
  agentId: string,
  baseUrl: string,
  warnings?: string[],
): void {
  const type = record['type'];
  if (type === 'turn.prompt' || type === 'turn.steer') {
    rehydrateParts(
      asContentParts(record['input'], warnings),
      sessionId,
      agentId,
      baseUrl,
      warnings,
    );
    return;
  }
  if (type === 'context.append_message') {
    const message = record['message'];
    if (message === null || typeof message !== 'object') {
      warnMalformed(warnings, 'context.append_message.message');
      return;
    }
    rehydrateParts(
      asContentParts((message as Record<string, unknown>)['content'], warnings),
      sessionId,
      agentId,
      baseUrl,
      warnings,
    );
    return;
  }
  if (type === 'context.append_loop_event') {
    const event = record['event'];
    if (event === null || typeof event !== 'object') {
      warnMalformed(warnings, 'context.append_loop_event.event');
      return;
    }
    const eventRecord = event as Record<string, unknown>;
    if (eventRecord['type'] === 'tool.result') {
      const result = eventRecord['result'];
      if (result === null || typeof result !== 'object') {
        warnMalformed(warnings, 'tool.result.result');
        return;
      }
      const output = (result as Record<string, unknown>)['output'];
      if (typeof output !== 'string') {
        rehydrateParts(asContentParts(output, warnings), sessionId, agentId, baseUrl, warnings);
      }
    } else if (eventRecord['type'] === 'content.part') {
      rehydrateParts(asContentParts([eventRecord['part']], warnings), sessionId, agentId, baseUrl, warnings);
    }
    return;
  }
}

/** Narrow an unknown into a ContentPart[]; a non-array or a non-object entry
 *  is reported and dropped so the caller can keep walking. */
function asContentParts(value: unknown, warnings?: string[]): ContentPart[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    warnMalformed(warnings, 'content parts');
    return [];
  }
  const parts: ContentPart[] = [];
  for (const part of value) {
    if (part === null || typeof part !== 'object') {
      warnMalformed(warnings, 'content part entry');
      continue;
    }
    parts.push(part as ContentPart);
  }
  return parts;
}

function rehydrateParts(
  parts: ContentPart[],
  sessionId: string,
  agentId: string,
  baseUrl: string,
  warnings?: string[],
): void {
  for (const part of parts) {
    switch (part.type) {
      case 'image_url': {
        const url = readNestedUrl(part.imageUrl, warnings, 'image_url');
        if (url !== undefined) part.imageUrl.url = resolveBlobRefUrl(url, sessionId, agentId, baseUrl);
        break;
      }
      case 'audio_url': {
        const url = readNestedUrl(part.audioUrl, warnings, 'audio_url');
        if (url !== undefined) part.audioUrl.url = resolveBlobRefUrl(url, sessionId, agentId, baseUrl);
        break;
      }
      case 'video_url': {
        const url = readNestedUrl(part.videoUrl, warnings, 'video_url');
        if (url !== undefined) part.videoUrl.url = resolveBlobRefUrl(url, sessionId, agentId, baseUrl);
        break;
      }
      default:
        break;
    }
  }
}

/** Read `part.<field>.url` defensively: a missing wrapper or a non-string url
 *  is reported and skipped instead of throwing a TypeError mid-walk. */
function readNestedUrl(
  wrapper: unknown,
  warnings: string[] | undefined,
  field: string,
): string | undefined {
  if (wrapper === null || typeof wrapper !== 'object') {
    warnMalformed(warnings, `${field}.url`);
    return undefined;
  }
  const url = (wrapper as Record<string, unknown>)['url'];
  if (typeof url !== 'string') {
    warnMalformed(warnings, `${field}.url`);
    return undefined;
  }
  return url;
}

export function isSafeBlobHash(hash: string): boolean {
  return /^[a-f0-9]{64}$/.test(hash);
}
