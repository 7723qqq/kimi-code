/**
 * `sessionQuery` domain — opaque pagination cursor.
 *
 * A transparent offset cursor for full-text search pages. Consumers treat it
 * as opaque: it is only meaningful for the identical normalized request.
 */

export interface SessionSearchCursor {
  readonly __sessionSearchCursor: unique symbol;
  /** 1-based page offset of the next page. */
  readonly offset: number;
}

/** Brand an offset as a {@link SessionSearchCursor}. */
export function SessionSearchCursor(offset: number): SessionSearchCursor {
  return { __sessionSearchCursor: undefined as never, offset };
}
