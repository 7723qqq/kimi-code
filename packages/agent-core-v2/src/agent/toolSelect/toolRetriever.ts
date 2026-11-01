import { isRecord } from '#/_base/utils/guards';
import type { ToolInfo } from '#/tool/toolContract';

export interface ToolSearchHit {
  readonly name: string;
  readonly description: string;
  readonly score: number;
}

const K1 = 1.2;
const B = 0.75;
const MAX_QUERY_TOKENS = 256;
const MAX_DOCUMENT_TOKENS = 512;
const MAX_PARAMETER_NAMES = 32;
const MIN_SCORE_RATIO = 0.15;
const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'can',
  'for',
  'from',
  'in',
  'is',
  'it',
  'its',
  'of',
  'on',
  'or',
  'that',
  'the',
  'these',
  'this',
  'those',
  'to',
  'tool',
  'tools',
  'use',
  'using',
  'with',
  'you',
  'your',
]);

export function rankToolsByQuery(
  entries: readonly ToolInfo[],
  query: string,
  limit: number,
): readonly ToolSearchHit[] {
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  if (entries.length === 0) return [];
  if (query.trim().length === 0) {
    return entries.slice(0, safeLimit).map((entry) => toHit(entry, 0));
  }
  const queryTokens = tokenize(query)
    .filter((term) => !STOPWORDS.has(term))
    .slice(0, MAX_QUERY_TOKENS);
  if (queryTokens.length === 0) {
    return entries.slice(0, safeLimit).map((entry) => toHit(entry, 0));
  }
  const documents = entries.map((entry) => ({
    entry,
    tokens: documentTokens(entry).slice(0, MAX_DOCUMENT_TOKENS),
  }));
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const term of new Set(document.tokens)) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }
  const averageLength =
    documents.reduce((total, document) => total + document.tokens.length, 0) / documents.length;
  const queryFrequency = new Map<string, number>();
  for (const term of queryTokens) {
    queryFrequency.set(term, (queryFrequency.get(term) ?? 0) + 1);
  }
  const hits: ToolSearchHit[] = [];
  for (const document of documents) {
    const termFrequency = new Map<string, number>();
    for (const term of document.tokens) {
      termFrequency.set(term, (termFrequency.get(term) ?? 0) + 1);
    }
    let score = 0;
    for (const [term, queryCount] of queryFrequency) {
      const frequency = termFrequency.get(term) ?? 0;
      if (frequency === 0) continue;
      const containing = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - containing + 0.5) / (containing + 0.5));
      const denominator =
        frequency + K1 * (1 - B + (B * document.tokens.length) / Math.max(1, averageLength));
      score += (idf * (frequency * (K1 + 1))) / denominator * queryCount;
    }
    if (score > 0) hits.push(toHit(document.entry, score));
  }
  const ranked = hits.toSorted(
    (left, right) => right.score - left.score || left.name.localeCompare(right.name),
  );
  const best = ranked[0]?.score;
  if (best === undefined) return [];
  return ranked.filter((hit) => hit.score >= best * MIN_SCORE_RATIO).slice(0, safeLimit);
}

function toHit(entry: ToolInfo, score: number): ToolSearchHit {
  return { name: entry.name, description: entry.description, score };
}

function documentTokens(entry: ToolInfo): string[] {
  const tokens = [entry.name, entry.name, entry.description, entry.source];
  for (const parameter of parameterNames(entry.parameters)) tokens.push(parameter);
  return tokens.flatMap((part) => tokenize(part)).filter((term) => !STOPWORDS.has(term));
}

function parameterNames(parameters: Record<string, unknown> | undefined): string[] {
  if (!isRecord(parameters)) return [];
  const properties = parameters['properties'];
  if (!isRecord(properties)) return [];
  return Object.keys(properties).slice(0, MAX_PARAMETER_NAMES);
}

function tokenize(text: string): string[] {
  const words = text.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const tokens: string[] = [];
  for (const word of words) {
    tokens.push(word);
    if (/[\u3400-\u9FFF]/.test(word)) {
      for (let index = 0; index < word.length - 1; index += 1) {
        tokens.push(word.slice(index, index + 2));
      }
    }
  }
  return tokens;
}
