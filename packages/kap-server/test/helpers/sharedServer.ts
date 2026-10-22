export interface SharedServerContext {
  readonly base: string;
  readonly token: string;
}

let current: SharedServerContext | undefined;

export function setSharedServer(context: SharedServerContext): void {
  current = context;
}

export function sharedServer(): SharedServerContext {
  if (current === undefined) throw new Error('the shared server is not running');
  return current;
}

export function sharedAuthHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, authorization: `Bearer ${sharedServer().token}` };
}

interface SharedFetchOptions {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export async function sharedAuthedFetch(
  path: string,
  init: SharedFetchOptions = {},
): Promise<Response> {
  return fetch(`${sharedServer().base}${path}`, {
    ...init,
    headers: sharedAuthHeaders(init.headers),
  } as never);
}
