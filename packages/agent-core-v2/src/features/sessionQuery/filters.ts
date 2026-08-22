import { Error2 } from '#/errors';

import { SessionQueryErrors } from './errors';
import type { SessionRecord, SessionResultFilter, SessionResultRange } from './types';
/**
 * Apply ANDed logical-session filters while preserving input order.
 * @param records - detached logical-session records to inspect.
 * @param filters - clauses whose list values are ORed within each clause.
 * @returns records accepted by every clause.
 */
export function filterSessionResults<T extends SessionRecord>(
  records: readonly T[],
  filters: readonly SessionResultFilter[] = [],
): T[] {
  const predicates = filters.map(sessionPredicate);
  return records.filter((record) => predicates.every((predicate) => predicate(record)));
}

/**
 * Copy and validate logical-session filters before an asynchronous boundary.
 * @param filters - caller-owned clauses to materialize.
 * @returns detached validated clauses.
 */
export function materializeSessionResultFilters(
  filters: readonly SessionResultFilter[],
): SessionResultFilter[] {
  if (!Array.isArray(filters)) throw invalidFilter('filters must be an array');
  return filters.map((filter) => {
    switch (filter.kind) {
      case 'id':
        return { kind: filter.kind, values: copyStrings(filter.kind, filter.values) };
      case 'cwd':
        return { kind: filter.kind, values: copyNullableStrings(filter.kind, filter.values) };
      case 'created-at':
        return copyRange(filter.kind, filter);
      case 'parent':
        return { kind: filter.kind, values: copyNullableStrings(filter.kind, filter.values) };
      case 'availability': {
        const values = copyStrings(filter.kind, filter.values);
        assertAllowedValues(filter.kind, values, ['live', 'persisted']);
        return { kind: filter.kind, values };
      }
      default:
        return unknownFilter(filter as never);
    }
  });
}

function sessionPredicate(filter: SessionResultFilter): (record: SessionRecord) => boolean {
  switch (filter.kind) {
    case 'id':
      return (record) => filter.values.includes(record.id);
    case 'cwd':
      return (record) => filter.values.includes(record.cwd ?? null);
    case 'created-at': {
      const range = validateRange(filter.kind, filter);
      return (record) => matchesRange(record.createdAt, range);
    }
    case 'parent':
      return (record) => filter.values.includes(record.parentSessionId ?? null);
    case 'availability':
      assertAllowedValues(filter.kind, filter.values, ['live', 'persisted']);
      return (record) =>
        filter.values.some((value) => (value === 'live' ? record.live : record.persisted));
    default:
      return unknownFilter(filter);
  }
}

function copyStrings(name: string, values: readonly string[]): string[] {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw invalidFilter(`${name} filter values must be an array of strings`);
  }
  return [...values];
}

function copyNullableStrings(
  name: string,
  values: readonly (string | null)[],
): Array<string | null> {
  if (
    !Array.isArray(values) ||
    values.some((value) => value !== null && typeof value !== 'string')
  ) {
    throw invalidFilter(`${name} filter values must be an array of strings or null`);
  }
  return [...values];
}

function copyRange(
  kind: 'created-at',
  range: SessionResultRange,
): { kind: 'created-at' } & SessionResultRange {
  const copy: { kind: 'created-at' } & SessionResultRange = {
    kind,
    ...(range.from === undefined ? {} : { from: range.from }),
    ...(range.to === undefined ? {} : { to: range.to }),
  };
  validateRange(kind, copy);
  return copy;
}

function unknownFilter(filter: never): never {
  const kind = (filter as { kind?: unknown }).kind;
  throw invalidFilter(
    `unknown filter kind ${typeof kind === 'string' ? `"${kind}"` : '(missing)'}`,
  );
}

function assertAllowedValues(
  name: string,
  values: readonly string[],
  allowed: readonly string[],
): void {
  for (const value of values) {
    if (!allowed.includes(value)) {
      throw invalidFilter(`${name} filter contains unknown value "${value}"`);
    }
  }
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

function invalidRange(name: string, detail: string): Error2 {
  return invalidFilter(`${name} filter ${detail}`);
}

function invalidFilter(detail: string): Error2 {
  return new Error2(SessionQueryErrors.codes.SESSION_QUERY_INVALID_FILTER, `session ${detail}`);
}
