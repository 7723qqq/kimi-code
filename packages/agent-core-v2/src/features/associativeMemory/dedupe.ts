import { tokenize } from '@moonshot-ai/minidb';

export function noteTerms(text: string): readonly string[] {
  return [...new Set(tokenize(text).map((term) => term.toLowerCase()))].sort();
}

export function noteFingerprint(text: string): string {
  const terms = noteTerms(text);
  return new Bun.CryptoHasher('sha256').update(terms.join('\u0000')).digest('hex').slice(0, 24);
}
