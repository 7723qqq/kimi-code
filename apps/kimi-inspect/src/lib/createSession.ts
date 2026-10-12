/**
 * Session creation over the v1 REST endpoint (`POST {baseUrl}/api/v1/sessions`).
 *
 * The HTTP parse lives here so every outcome is a value instead of an
 * exception: transport failure, non-2xx, non-JSON body and a non-zero business
 * code all come back as `{ ok: false, reason }`, and the caller decides how to
 * surface them. `reason` is a short technical detail (the caller adds the
 * user-facing prefix); the server's own `msg` is passed through when present.
 */

export interface CreateSessionOptions {
  readonly baseUrl: string;
  /** Empty/undefined = no authorization header. */
  readonly token?: string | undefined;
  /** Test seam; defaults to the global `fetch`. */
  readonly fetchImpl?: typeof fetch | undefined;
  /** With a workspace the server derives workDir from its root. */
  readonly workspaceId?: string | undefined;
  /** Without a workspace the caller passes the prompted directory. */
  readonly cwd?: string | undefined;
}

export type CreateSessionResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly reason: string };

export async function createSession(opts: CreateSessionOptions): Promise<CreateSessionResult> {
  const body =
    opts.workspaceId !== undefined
      ? JSON.stringify({ workspace_id: opts.workspaceId })
      : JSON.stringify({ metadata: { cwd: opts.cwd ?? '' } });

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.token !== undefined && opts.token !== '') {
    headers['authorization'] = `Bearer ${opts.token}`;
  }

  const doFetch = opts.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${opts.baseUrl}/api/v1/sessions`, { method: 'POST', headers, body });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  if (!res.ok) return { ok: false, reason: `HTTP ${String(res.status)}` };

  let envelope: unknown;
  try {
    envelope = await res.json();
  } catch {
    return { ok: false, reason: `HTTP ${String(res.status)} (non-JSON body)` };
  }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
    return { ok: false, reason: `HTTP ${String(res.status)} (unexpected body)` };
  }

  const { code, msg, data } = envelope as { code?: unknown; msg?: unknown; data?: unknown };
  if (code !== 0) {
    if (typeof msg === 'string' && msg !== '') return { ok: false, reason: msg };
    return { ok: false, reason: `code ${String(code)} (no message)` };
  }

  const id = data !== null && typeof data === 'object' ? (data as { id?: unknown }).id : undefined;
  if (typeof id !== 'string' || id === '') {
    return { ok: false, reason: `HTTP ${String(res.status)} (no data.id)` };
  }
  return { ok: true, sessionId: id };
}
