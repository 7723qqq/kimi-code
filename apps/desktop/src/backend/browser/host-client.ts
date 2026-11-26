import type { BrowserRunRequest, BrowserRunResult } from '../../shared/browser-automation';
import type { BrowserSubagentRun } from '../../shared/browser-run';
import type { DesktopBrowserAgentControl } from './browser-mcp';
import type { BrowserDialogReminder, DesktopBrowserHost, DesktopBrowserHostState } from './host';
import { trySendDesktopEvent } from '../diagnostics/track';

const STATE_POLL_MS = 1_000;

interface HostRunResponse {
  readonly result?: BrowserRunResult;
  readonly error?: string;
}

function controlFrom(state: () => DesktopBrowserHostState, key: 'agentControl' | 'subagentControl'): DesktopBrowserAgentControl & { notify(enabled: boolean): void } {
  const listeners = new Set<(enabled: boolean) => void>();
  let current: boolean | undefined;
  return {
    enabled: () => {
      const value = state()[key];
      if (current !== value) current = value;
      return value;
    },
    onDidChange(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    notify(enabled: boolean) {
      if (current === enabled) return;
      current = enabled;
      for (const listener of listeners) listener(enabled);
    },
  } as DesktopBrowserAgentControl & { notify(enabled: boolean): void };
}

export interface DesktopBrowserHostClient extends DesktopBrowserHost {
  readonly agentControl: DesktopBrowserAgentControl & { notify(enabled: boolean): void };
  readonly subagentControl: DesktopBrowserAgentControl & { notify(enabled: boolean): void };
  readonly localFilesEnabled: () => boolean;
  refresh(): Promise<void>;
  close(): void;
}

export function createDesktopBrowserHostClient(url: string, token: string): DesktopBrowserHostClient {
  let state: DesktopBrowserHostState = { agentControl: false, subagentControl: false, localFiles: false };
  let closed = false;
  let refreshing: Promise<void> | undefined;
  const agentControl = controlFrom(() => state, 'agentControl');
  const subagentControl = controlFrom(() => state, 'subagentControl');

  const request = async (path: string, init: RequestInit = {}): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${token}`);
    if (init.body !== undefined) headers.set('Content-Type', 'application/json');
    const response = await fetch(new URL(path, url), { ...init, headers });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new Error(`Browser host ${path} failed: ${response.status} ${text}`);
    }
    return response;
  };

  const refresh = async (): Promise<void> => {
    if (closed) return;
    refreshing ??= (async () => {
      try {
        const response = await request('/state');
        const next = (await response.json()) as Partial<DesktopBrowserHostState>;
        const previous = state;
        state = {
          agentControl: next.agentControl === true,
          subagentControl: next.subagentControl === true,
          localFiles: next.localFiles === true,
        };
        if (previous.agentControl !== state.agentControl) agentControl.notify(state.agentControl);
        if (previous.subagentControl !== state.subagentControl) subagentControl.notify(state.subagentControl);
      } finally {
        refreshing = undefined;
      }
    })();
    await refreshing;
  };

  void refresh().catch(() => {});
  const poll = setInterval(() => { void refresh().catch(() => {}); }, STATE_POLL_MS);
  poll.unref?.();

  return {
    url,
    token,
    agentControl,
    subagentControl,
    localFilesEnabled: () => state.localFiles,
    refresh,
    close: () => {
      if (closed) return;
      closed = true;
      clearInterval(poll);
    },
    state: async () => {
      await refresh();
      return state;
    },
    async run(input: BrowserRunRequest, signal: AbortSignal | undefined, sessionId: string | undefined, run: BrowserSubagentRun | undefined) {
      const response = await request('/run', {
        method: 'POST',
        body: JSON.stringify({ input, sessionId, run }),
        signal,
      });
      const payload = (await response.json()) as HostRunResponse;
      if (payload.result === undefined) throw new Error(payload.error ?? 'Browser host returned no result');
      return payload.result;
    },
    async collectDialogs(sessionId: string): Promise<BrowserDialogReminder | undefined> {
      const response = await request(`/dialogs?sessionId=${encodeURIComponent(sessionId)}`);
      const payload = (await response.json()) as { reminder?: BrowserDialogReminder };
      return payload.reminder;
    },
    forgetSession(sessionId: string): void {
      void request('/dialogs/forget', { method: 'POST', body: JSON.stringify({ sessionId }) }).catch(() => {});
    },
    restoreSubagentRuns(): void {
      void request('/restore-subagent-runs', { method: 'POST' }).catch(() => {});
    },
    revokeSubagentRun(sessionId: string, run: BrowserSubagentRun): void {
      void request('/revoke-subagent-run', { method: 'POST', body: JSON.stringify({ sessionId, run }) }).catch(() => {});
    },
    track(event: string, properties?: Record<string, unknown>): void {
      trySendDesktopEvent(event, properties as never);
    },
  };
}
