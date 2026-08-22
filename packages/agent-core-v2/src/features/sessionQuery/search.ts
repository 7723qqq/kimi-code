import { tokenize } from '@moonshot-ai/minidb';

import { Error2 } from '#/errors';

import { SessionSearchCursor } from './cursor';
import { SessionQueryErrors } from './errors';
import type {
  SessionEventResultFilter,
  SessionEventSearchDocument,
  SessionEventSearchHit,
} from './events';
import type { SessionResultRange } from './types';

const SNIPPET_RADIUS = 40;
const DEFAULT_PAGE_LIMIT = 10;
const MAX_PAGE_LIMIT = 100;

/**
 * Apply ANDed event filters, preserving input order.
 * @param documents - event documents to inspect.
 * @param filters - clauses whose list values are ORed within each clause.
 * @returns documents accepted by every clause, in input order.
 */
export function filterSessionEvents(
  documents: readonly SessionEventSearchDocument[],
  filters: readonly SessionEventResultFilter[] = [],
): SessionEventSearchDocument[] {
  const predicates = filters.map(eventPredicate);
  return documents.filter((document) => predicates.every((predicate) => predicate(document)));
}

/**
 * Rank event documents by full-text relevance and page them.
 * @param documents - event documents (already metadata-filtered) to rank.
 * @param query - literal query text, tokenized for matching.
 * @param limit - page size (default 10, capped at 100).
 * @param cursor - opaque page cursor from a previous identical request.
 * @returns the ranked page and the continuation cursor.
 */
export function searchEventDocuments(
  documents: readonly SessionEventSearchDocument[],
  query: string,
  limit = DEFAULT_PAGE_LIMIT,
  cursor?: SessionSearchCursor,
): { items: SessionEventSearchHit[]; nextCursor?: SessionSearchCursor } {
  const pageSize = Math.min(Math.max(1, Math.trunc(limit)), MAX_PAGE_LIMIT);
  const queryTerms = [...new Set(tokenize(query))];
  if (queryTerms.length === 0) {
    throw new Error2(
      SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER,
      'session search query must contain searchable text',
    );
  }

  const ranked: SessionEventSearchHit[] = [];
  for (const document of documents) {
    const text = document.text;
    if (text.length === 0) continue;
    const terms = tokenize(text);
    const score = queryTerms.reduce(
      (sum, term) => sum + terms.filter((candidate) => candidate === term).length,
      0,
    );
    if (score === 0) continue;
    const snippet = buildSnippet(text, queryTerms);
    ranked.push({
      sessionId: document.sessionId,
      seq: document.seq,
      type: document.type,
      time: document.time,
      snippet,
    });
  }
  ranked.sort((a, b) => b.time - a.time);

  const offset = cursor?.offset ?? 0;
  const items = ranked.slice(offset, offset + pageSize);
  const nextCursor =
    offset + pageSize < ranked.length ? SessionSearchCursor(offset + pageSize) : undefined;
  return { items, nextCursor };
}

function eventPredicate(
  filter: SessionEventResultFilter,
): (document: SessionEventSearchDocument) => boolean {
  switch (filter.kind) {
    case 'seq': {
      const range = validateRange(filter.kind, filter);
      return (document) => matchesRange(document.seq, range);
    }
    case 'time': {
      const range = validateRange(filter.kind, filter);
      return (document) => matchesRange(document.time, range);
    }
    case 'type':
      return (document) => filter.values.includes(document.type);
    case 'text': {
      const pattern = compileSessionTextFilter(filter.text);
      return (document) => pattern.test(document.text);
    }
    default:
      return unknownFilter(filter);
  }
}

/**
 * Compile a literal case-insensitive, whitespace-flexible semantic-text
 * match safe from regex injection.
 * @param text - caller-provided literal text.
 * @returns Unicode-aware regular expression.
 */
export function compileSessionTextFilter(text: string): RegExp {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    throw new Error2(
      SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER,
      'session text filter must contain non-whitespace text',
    );
  }
  const pattern = trimmed
    .split(/\s+/u)
    .map((part) => part.replaceAll(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
    .join('\\s+');
  return new RegExp(pattern, 'iu');
}

function validateRange(name: string, range: SessionResultRange): SessionResultRange {
  if (range.from !== undefined && !Number.isFinite(range.from)) {
    throw invalidRange(name, 'from must be finite');
  }
  if (range.to !== undefined && !Number.isFinite(range.to)) {
    throw invalidRange(name, 'to must be finite');
  }
  if (range.from !== undefined && range.to !== undefined && range.from > range.to) {
    throw invalidRange(name, 'from must be less than or equal to to');
  }
  return range;
}

function matchesRange(value: number, range: SessionResultRange): boolean {
  return (
    (range.from === undefined || value >= range.from) &&
    (range.to === undefined || value <= range.to)
  );
}

function unknownFilter(filter: never): never {
  const kind = (filter as { kind?: unknown }).kind;
  throw invalidFilter(
    `unknown filter kind ${typeof kind === 'string' ? `"${kind}"` : '(missing)'}`,
  );
}

function invalidRange(name: string, detail: string): Error2 {
  return invalidFilter(`${name} filter ${detail}`);
}

function invalidFilter(detail: string): Error2 {
  return new Error2(SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER, `session ${detail}`);
}

function buildSnippet(text: string, terms: readonly string[]): string {
  const lower = text.toLowerCase();
  let firstMatch = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index !== -1 && (firstMatch === -1 || index < firstMatch)) firstMatch = index;
  }
  if (firstMatch === -1) return text.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, firstMatch - SNIPPET_RADIUS);
  const end = Math.min(text.length, firstMatch + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).replaceAll(/\s+/g, ' ')}${suffix}`;
}
