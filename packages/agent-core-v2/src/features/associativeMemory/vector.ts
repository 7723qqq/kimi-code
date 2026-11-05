import type { Atom } from './types';

export function computeDf(atoms: readonly Atom[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const atom of atoms) {
    for (const term of new Set(atom.terms)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }
  return df;
}

export function tfidf(
  terms: readonly string[],
  df: ReadonlyMap<string, number>,
  totalDocs: number,
): Record<string, number> {
  if (terms.length === 0) return {};
  const tf = new Map<string, number>();
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
  const vector: Record<string, number> = {};
  for (const [term, count] of tf) {
    const idf = Math.log((totalDocs + 1) / ((df.get(term) ?? 0) + 1)) + 1;
    vector[term] = (count / terms.length) * idf;
  }
  return vector;
}

export function termFrequency(terms: readonly string[]): Record<string, number> {
  if (terms.length === 0) return {};
  const tf = new Map<string, number>();
  for (const term of terms) tf.set(term, (tf.get(term) ?? 0) + 1);
  const vector: Record<string, number> = {};
  for (const [term, count] of tf) vector[term] = count / terms.length;
  return vector;
}

export function cosine(
  a: Readonly<Record<string, number>>,
  b: Readonly<Record<string, number>>,
): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const [term, value] of Object.entries(a)) {
    normA += value * value;
    const other = b[term];
    if (other !== undefined) dot += value * other;
  }
  for (const value of Object.values(b)) normB += value * value;
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function averageVector(vectors: readonly Readonly<Record<string, number>>[]): Record<string, number> {
  if (vectors.length === 0) return {};
  const sum = new Map<string, number>();
  for (const vector of vectors) {
    for (const [term, value] of Object.entries(vector)) {
      sum.set(term, (sum.get(term) ?? 0) + value);
    }
  }
  const out: Record<string, number> = {};
  for (const [term, value] of sum) out[term] = value / vectors.length;
  return out;
}

export function averageDense(
  vectors: readonly (readonly number[])[],
): readonly number[] | undefined {
  if (vectors.length === 0) return undefined;
  const length = vectors[0]!.length;
  if (length === 0 || !vectors.every((vector) => vector.length === length)) return undefined;
  const out = Array.from({ length }, () => 0);
  for (const vector of vectors) {
    for (let index = 0; index < length; index++) {
      out[index] = (out[index] ?? 0) + vector[index]! / vectors.length;
    }
  }
  return out;
}

export function cosineDense(a: readonly number[], b: readonly number[]): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < length; index++) {
    const x = a[index]!;
    const y = b[index]!;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function topTerms(vector: Readonly<Record<string, number>>, limit: number): string[] {
  return Object.entries(vector)
    .toSorted((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, limit)
    .map(([term]) => term);
}
