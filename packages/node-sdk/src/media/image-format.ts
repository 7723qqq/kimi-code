export const MODEL_ACCEPTED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
]);

const ACCEPTED_FORMATS_TEXT = 'PNG, JPEG, GIF, and WebP';

export function normalizeImageMime(mimeType: string): string {
  const lower = mimeType.trim().toLowerCase();
  const semi = lower.indexOf(';');
  const base = (semi === -1 ? lower : lower.slice(0, semi)).trim();
  return base === 'image/jpg' ? 'image/jpeg' : base;
}

const BASE64_SNIFF_CHARS = 48;

export function decodeBase64Prefix(base64: string): Buffer {
  return Buffer.from(base64.slice(0, BASE64_SNIFF_CHARS), 'base64');
}

export function parseImageDataUrl(url: string): { mimeType: string; base64: string } | null {
  const match = /^data:([^;,]+)(?:;[^;,]+)*?;base64,(.*)$/si.exec(url);
  if (match === null) return null;
  return { mimeType: match[1]!, base64: match[2]! };
}

export function isDataUrl(url: string): boolean {
  return url.toLowerCase().startsWith('data:');
}

export function isModelAcceptedImageMime(mimeType: string): boolean {
  return MODEL_ACCEPTED_IMAGE_MIMES.has(normalizeImageMime(mimeType));
}

export function buildUnsupportedImageNotice(mimeType: string, name?: string): string {
  const what =
    name === undefined || name.length === 0
      ? `unsupported image format ${mimeType}`
      : `"${name}" uses unsupported image format ${mimeType}`;
  return (
    `[Image omitted: ${what}. Model providers accept only ${ACCEPTED_FORMATS_TEXT} — ` +
    'convert it to PNG or JPEG and try again.]'
  );
}

export function buildMalformedImageNotice(url: string): string {
  const shown = url.length > 80 ? `${url.slice(0, 80)}…` : url;
  return (
    `[Image omitted: "${shown}" is not a valid data URL (its header or payload ` +
    'could not be parsed). Re-encode the image as PNG or JPEG and try again.]'
  );
}
