export function isAnimatedWebp(bytes: Uint8Array): boolean {
  if (bytes.length < 21) return false;
  return (
    hasAscii(bytes, 'RIFF', 0) &&
    hasAscii(bytes, 'WEBP', 8) &&
    hasAscii(bytes, 'VP8X', 12) &&
    (bytes[20]! & 0x02) !== 0
  );
}

function hasAscii(bytes: Uint8Array, text: string, at: number): boolean {
  for (let i = 0; i < text.length; i++) {
    if (bytes[at + i] !== text.codePointAt(i)) return false;
  }
  return true;
}
