import { fileURLToPath, pathToFileURL } from 'node:url';

import type { LspHover, LspLocation, LspLocationLink } from './protocol';

export function normalizeLocationsResponse(response: unknown): LspLocation[] {
  if (response === null || response === undefined) return [];
  if (Array.isArray(response)) {
    return response.map((entry) => normalizeLocationEntry(entry));
  }
  return [normalizeLocationEntry(response)];
}

function normalizeLocationEntry(entry: unknown): LspLocation {
  if (isLocationLink(entry)) {
    return {
      uri: entry.targetUri,
      range: entry.targetRange,
    };
  }
  if (isLocation(entry)) {
    return entry;
  }
  throw new TypeError(`malformed LSP location response: ${JSON.stringify(entry)}`);
}

function isLocation(value: unknown): value is LspLocation {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly uri?: unknown; readonly range?: unknown };
  return (
    typeof candidate.uri === 'string' &&
    typeof candidate.range === 'object' &&
    candidate.range !== null
  );
}

function isLocationLink(value: unknown): value is LspLocationLink {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { readonly targetUri?: unknown; readonly targetRange?: unknown };
  return (
    typeof candidate.targetUri === 'string' &&
    typeof candidate.targetRange === 'object' &&
    candidate.targetRange !== null
  );
}

export function normalizeHoverResponse(response: unknown): LspHover | null {
  if (response === null || response === undefined) return null;
  if (typeof response !== 'object') {
    throw new TypeError(`malformed LSP hover response: ${JSON.stringify(response)}`);
  }
  return response as LspHover;
}

export function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  try {
    return fileURLToPath(uri);
  } catch {
    return uri;
  }
}

export function pathToUri(path: string): string {
  return pathToFileURL(path).toString();
}
