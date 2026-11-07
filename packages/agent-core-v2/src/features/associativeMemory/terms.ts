export const STOP_TERMS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'for', 'with', 'by', 'as', 'at',
  'is', 'are', 'was', 'were', 'be', 'been', 'being', 'it', 'its', 'this', 'that', 'these',
  'those', 'from', 'into', 'over', 'after', 'before', 'than', 'then', 'so', 'if', 'but',
  'not', 'no', 'we', 'you', 'they', 'he', 'she', 'i', 'our', 'their', 'has', 'have', 'had',
]);

export const PREFIX_MATCH_MIN = 4;

export function relatedTerms(left: string, right: string): boolean {
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  return shorter.length >= PREFIX_MATCH_MIN && longer.startsWith(shorter);
}

export function matchesAny(term: string, candidates: readonly string[]): boolean {
  for (const candidate of candidates) {
    if (relatedTerms(term, candidate)) return true;
  }
  return false;
}

export interface TextKeyed {
  readonly id: string;
  readonly text: string;
}

export function compareByText(left: TextKeyed, right: TextKeyed): number {
  if (left.text !== right.text) return left.text < right.text ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}
