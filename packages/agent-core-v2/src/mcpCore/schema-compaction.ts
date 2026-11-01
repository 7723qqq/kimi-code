const MAX_DESCRIPTION_CHARS = 160;
const MAX_DEPTH = 64;
const DROPPED_KEYS = new Set(['title', 'examples', '$comment']);

export function compactMcpInputSchema(schema: Record<string, unknown>): Record<string, unknown> {
  return compactValue(schema, 0) as Record<string, unknown>;
}

function compactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (Array.isArray(value)) {
    return value.map((item) => compactValue(item, depth + 1));
  }
  if (typeof value !== 'object' || value === null) return value;
  const compacted: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (DROPPED_KEYS.has(key)) continue;
    if (key === 'description' && typeof child === 'string') {
      compacted[key] = firstSentence(child);
      continue;
    }
    compacted[key] = compactValue(child, depth + 1);
  }
  return compacted;
}

function firstSentence(text: string): string {
  const normalized = text.replaceAll(/\s+/g, ' ').trim();
  if (normalized.length === 0) return '';
  const sentence = normalized.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? normalized;
  if (sentence.length <= MAX_DESCRIPTION_CHARS) return sentence;
  const cut = sentence.slice(0, MAX_DESCRIPTION_CHARS);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}
