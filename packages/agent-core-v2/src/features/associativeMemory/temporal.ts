import type { AssociativeMemoryParams, Atom } from './types';

export function compareAtomTime(left: Atom, right: Atom): number {
  if (left.createdAt !== right.createdAt) return left.createdAt - right.createdAt;
  if (left.noteId !== right.noteId) return 0;
  return left.spanStart - right.spanStart;
}

export function stdpDrive(candidate: Atom, other: Atom, params: AssociativeMemoryParams): number {
  const order = compareAtomTime(other, candidate);
  if (order === 0) return 0;
  const distance =
    other.noteId === candidate.noteId
      ? Math.abs(other.spanStart - candidate.spanStart) / params.maxAtomChars
      : Math.abs(other.createdAt - candidate.createdAt) / params.contextWindowMs;
  const decay = Math.exp(-distance / params.stdpTau);
  return (order < 0 ? params.stdpAPlus : -params.stdpAMinus) * decay;
}
