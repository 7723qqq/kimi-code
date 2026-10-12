const ASCII_FILENAME_DISALLOWED = /[^\w. ()+[\]-]+/g;

const RFC5987_ESCAPES: Record<string, string> = {
  "'": '%27',
  '(': '%28',
  ')': '%29',
  '*': '%2A',
};

function sanitizeAsciiFilename(name: string): string {
  const cleaned = name.replaceAll(ASCII_FILENAME_DISALLOWED, '_');
  return cleaned.length > 0 ? cleaned : 'download';
}

function rfc5987Encode(name: string): string {
  return encodeURIComponent(name).replaceAll(/['()*]/g, (char) => RFC5987_ESCAPES[char] ?? '');
}

export function buildContentDisposition(name: string, mediaType?: string): string {
  const disposition = /^(image|video|audio)\//.test(mediaType ?? '') ? 'inline' : 'attachment';
  const ascii = sanitizeAsciiFilename(name);
  const header = `${disposition}; filename="${ascii}"`;
  if (name.length === 0 || ascii === name) return header;
  return `${header}; filename*=UTF-8''${rfc5987Encode(name)}`;
}
