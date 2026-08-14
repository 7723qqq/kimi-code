/**
 * `sessionQuery` domain — `session_query` tool input schemas and
 * normalization.
 *
 * Ported from deepseek-harness `tool-session-query/src/input.ts` (MIT),
 * trimmed to the operations kimi's query service provides (session search,
 * event search, lineage trace) and to millisecond timestamps (kimi event
 * times are integer epoch milliseconds, so the upstream sub-millisecond
 * boundary handling is dropped).
 */

import { z } from 'zod';

import { Error2 } from '#/errors';

import { SessionQueryErrors } from './errors';
import type { SessionEventResultFilter, SessionResultFilter } from './types';

export const sessionSearchInputSchema = z
  .object({
    query: z.string().describe('Literal full-text query over prior session history.'),
    session_ids: z
      .array(z.string())
      .optional()
      .describe('Optional session ids to include.'),
    created_at_from: z
      .string()
      .optional()
      .describe('Inclusive ISO 8601 creation-time lower bound (e.g. 2026-08-01T00:00:00Z).'),
    created_at_to: z
      .string()
      .optional()
      .describe('Inclusive ISO 8601 creation-time upper bound.'),
    parent_session_ids: z
      .array(z.string())
      .optional()
      .describe('Optional direct parent session ids.'),
    include_root_sessions: z
      .boolean()
      .optional()
      .describe('Include sessions with no recorded parent in the parent filter.'),
    availability: z
      .array(z.enum(['live', 'persisted']))
      .optional()
      .describe('Require at least one selected source availability.'),
    event_seq_from: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Inclusive event sequence lower bound.'),
    event_seq_to: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe('Inclusive event sequence upper bound.'),
    event_time_from: z
      .string()
      .optional()
      .describe('Inclusive ISO 8601 event-time lower bound.'),
    event_time_to: z
      .string()
      .optional()
      .describe('Inclusive ISO 8601 event-time upper bound.'),
    event_types: z
      .array(z.string())
      .optional()
      .describe('Event types to include.'),
  })
  .strict();

export const eventSearchInputSchema = z
  .object({
    session_id: z
      .string()
      .optional()
      .describe('Target session id. Omit for the current session.'),
    query: z.string().describe('Literal full-text query over the target session.'),
    seq_from: z.number().int().nonnegative().optional().describe('Inclusive event sequence lower bound.'),
    seq_to: z.number().int().nonnegative().optional().describe('Inclusive event sequence upper bound.'),
    time_from: z.string().optional().describe('Inclusive ISO 8601 event-time lower bound.'),
    time_to: z.string().optional().describe('Inclusive ISO 8601 event-time upper bound.'),
    event_types: z.array(z.string()).optional().describe('Event types to include.'),
  })
  .strict();

export const sessionTraceInputSchema = z
  .object({
    session_id: z.string().optional().describe('Target session id. Omit for the current session.'),
  })
  .strict();

export interface SessionSearchInput {
  readonly query: string;
  readonly session_ids?: readonly string[];
  readonly created_at_from?: string;
  readonly created_at_to?: string;
  readonly parent_session_ids?: readonly string[];
  readonly include_root_sessions?: boolean;
  readonly availability?: readonly ('live' | 'persisted')[];
  readonly event_seq_from?: number;
  readonly event_seq_to?: number;
  readonly event_time_from?: string;
  readonly event_time_to?: string;
  readonly event_types?: readonly string[];
}

export interface EventSearchInput {
  readonly session_id?: string;
  readonly query: string;
  readonly seq_from?: number;
  readonly seq_to?: number;
  readonly time_from?: string;
  readonly time_to?: string;
  readonly event_types?: readonly string[];
}

/**
 * Build session filters from tool args.
 * @param args - validated tool arguments.
 * @returns ANDed session predicates.
 */
export function buildSessionFilters(args: SessionSearchInput): SessionResultFilter[] {
  const filters: SessionResultFilter[] = [];
  if (args.session_ids !== undefined) {
    assertNonEmptyArray('session_ids', args.session_ids);
    filters.push({ kind: 'id', values: [...args.session_ids] });
  }
  const created = timestampRange('created_at', args.created_at_from, args.created_at_to);
  if (created !== undefined) filters.push({ kind: 'created-at', ...created });
  if (args.parent_session_ids !== undefined) {
    assertNonEmptyArray('parent_session_ids', args.parent_session_ids);
    const values: Array<string | null> = [...new Set(args.parent_session_ids)];
    if (args.include_root_sessions === true) values.push(null);
    filters.push({ kind: 'parent', values });
  } else if (args.include_root_sessions === true) {
    filters.push({ kind: 'parent', values: [null] });
  }
  if (args.availability !== undefined) {
    assertNonEmptyArray('availability', args.availability);
    filters.push({ kind: 'availability', values: [...args.availability] });
  }
  return filters;
}

/**
 * Build event filters from tool args.
 * @param input - sequence/time/type bounds, or undefined for none.
 * @returns ANDed event predicates.
 */
export function buildEventFilters(input: {
  readonly seqFrom?: number;
  readonly seqTo?: number;
  readonly timeFrom?: string;
  readonly timeTo?: string;
  readonly eventTypes?: readonly string[];
}): SessionEventResultFilter[] {
  const filters: SessionEventResultFilter[] = [];
  const seq = sequenceRange(input.seqFrom, input.seqTo);
  if (seq.from !== undefined || seq.to !== undefined) filters.push({ kind: 'seq', ...seq });
  const time = timestampRange('time', input.timeFrom, input.timeTo);
  if (time !== undefined) filters.push({ kind: 'time', ...time });
  if (input.eventTypes !== undefined) {
    assertNonEmptyArray('event_types', input.eventTypes);
    filters.push({ kind: 'type', values: [...input.eventTypes] });
  }
  return filters;
}

/**
 * Normalize a search query: trim, collapse whitespace, reject empties and NUL.
 * @param value - raw query text.
 * @returns the normalized literal query.
 */
export function normalizeQuery(value: string): string {
  const query = value.trim().replaceAll(/\s+/gu, ' ');
  if (query.length === 0) {
    throw invalidQuery('session-search query must contain non-whitespace text');
  }
  if (query.includes('\0')) {
    throw invalidQuery('session-search query must not contain NUL');
  }
  return query;
}

function sequenceRange(from: number | undefined, to: number | undefined): { from?: number; to?: number } {
  if (from !== undefined) assertNonNegativeSafeInteger('sequence lower bound', from);
  if (to !== undefined) assertNonNegativeSafeInteger('sequence upper bound', to);
  if (from !== undefined && to !== undefined && from > to) {
    throw invalidRange('sequence', 'from must be less than or equal to to');
  }
  return {
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
  };
}

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

function timestampRange(
  name: string,
  from: string | undefined,
  to: string | undefined,
): { from?: number; to?: number } | undefined {
  if (from === undefined && to === undefined) return undefined;
  const fromTimestamp = from === undefined ? undefined : parseIsoTimestamp(`${name}_from`, from);
  const toTimestamp = to === undefined ? undefined : parseIsoTimestamp(`${name}_to`, to);
  if (fromTimestamp !== undefined && toTimestamp !== undefined && fromTimestamp > toTimestamp) {
    throw invalidRange(name, 'from must be less than or equal to to');
  }
  return {
    ...(fromTimestamp === undefined ? {} : { from: fromTimestamp }),
    ...(toTimestamp === undefined ? {} : { to: toTimestamp }),
  };
}

function parseIsoTimestamp(name: string, value: string): number {
  if (!ISO_TIMESTAMP.test(value)) {
    throw invalidRange(name, 'must be an ISO 8601 timestamp with Z or a numeric offset');
  }
  const timestamp = Date.parse(value);
  if (!Number.isSafeInteger(timestamp)) {
    throw invalidRange(name, 'must be a valid ISO 8601 timestamp');
  }
  return timestamp;
}

function invalidRange(name: string, detail: string): Error2 {
  return new Error2(
    SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER,
    `session ${name} range ${detail}`,
  );
}

function invalidQuery(detail: string): Error2 {
  return new Error2(
    SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER,
    detail,
  );
}

function assertNonEmptyArray(name: string, values: readonly unknown[]): void {
  if (values.length === 0) {
    throw new Error2(
      SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER,
      `${name} must contain at least one value when supplied`,
    );
  }
}

function assertNonNegativeSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error2(
      SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER,
      `${name} must be a non-negative safe integer`,
    );
  }
}
