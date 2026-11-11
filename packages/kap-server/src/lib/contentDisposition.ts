const MAX_ENCODED_FILENAME_LENGTH = 2048;
const MAX_FALLBACK_FILENAME_LENGTH = 256;

const RFC5987_ESCAPES: Record<string, string> = {
  "'": '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2A',
};

function sanitizeAsciiFilename(name: string): string {
  return name
    .replaceAll(/[^\u0020-\u007E]/g, '_')
    .replaceAll('\\', '\\\\')
    .replaceAll('"', '\\"');
}

function rfc5987Encode(name: string): string {
  return encodeURIComponent(name).replaceAll(/['()*]/g, (char) => RFC5987_ESCAPES[char] ?? '');
}

export function buildContentDisposition(
  name: string,
  mediaType?: string,
  dispositionOverride?: 'inline' | 'attachment',
): string {
  const disposition =
    dispositionOverride ??
    (/^(image|video|audio)\//.test(mediaType ?? '') ? 'inline' : 'attachment');
  const fallback = sanitizeAsciiFilename(name);
  const encoded = rfc5987Encode(name);
  const tooLong = encoded.length > MAX_ENCODED_FILENAME_LENGTH;
  const safeFallback = tooLong
    ? sanitizeAsciiFilename(name.slice(0, MAX_FALLBACK_FILENAME_LENGTH))
    : fallback;
  const filenameStar = fallback === name || tooLong ? '' : `; filename*=UTF-8''${encoded}`;
  return `${disposition}; filename="${safeFallback}"${filenameStar}`;
}
