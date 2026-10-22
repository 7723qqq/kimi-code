export function alignToCharacterStart(buffer: Uint8Array, offset: number): number {
  if (offset <= 0) return 0;
  let index = offset;
  while (index < buffer.byteLength && (buffer[index]! & 0b1100_0000) === 0b1000_0000) {
    index += 1;
  }
  return index;
}
