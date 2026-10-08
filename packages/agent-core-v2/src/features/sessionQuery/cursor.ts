export interface SessionSearchCursor {
  readonly __sessionSearchCursor: unique symbol;

  readonly offset: number;
}

export function SessionSearchCursor(offset: number): SessionSearchCursor {
  return { __sessionSearchCursor: undefined as never, offset };
}
