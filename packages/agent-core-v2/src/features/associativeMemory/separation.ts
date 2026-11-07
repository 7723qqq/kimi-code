import { relatedTerms, STOP_TERMS } from './terms';
import type { Atom, AssociativeMemoryParams } from './types';
import { cosine } from './vector';

export function sharesContentTerm(left: Atom, right: Atom): boolean {
  if (left.terms.length === 0 || right.terms.length === 0) return false;
  for (const term of left.terms) {
    if (STOP_TERMS.has(term)) continue;
    for (const other of right.terms) {
      if (STOP_TERMS.has(other)) continue;
      if (relatedTerms(term, other)) return true;
    }
  }
  return false;
}

export type MemorySeparationDecision = 'merge' | 'separate' | 'new';

export function memorySeparationDecision(
  candidate: Atom,
  existing: Atom,
  params: AssociativeMemoryParams,
): MemorySeparationDecision {
  const similarity = cosine(candidate.vector, existing.vector);
  if (similarity >= params.reconsolidateMergeThreshold) return 'merge';
  if (similarity >= params.supersedeThreshold && sharesContentTerm(candidate, existing)) return 'separate';
  if (similarity >= params.vectorThreshold && sharesContentTerm(candidate, existing)) return 'merge';
  return 'new';
}
