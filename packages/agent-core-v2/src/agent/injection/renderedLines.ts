export function lineFingerprint(line: string): string {
  return new Bun.CryptoHasher('sha256')
    .update(line.trim().toLowerCase())
    .digest('hex')
    .slice(0, 16);
}
