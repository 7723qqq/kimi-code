/**
 * React binding for the session activity hub: one hub per (server, token),
 * torn down on server switch or unmount. Consumers read per-session coarse
 * activity (`get(sessionId)`) and re-render on every store bump; list-level
 * signals invalidate the `['sessions']` / `['v2-sessions']` react-query lists
 * directly.
 *
 * The hub is created inside `useEffect` (not `useMemo`): under StrictMode
 * the mount → cleanup → re-mount cycle runs the cleanup of the FIRST mount,
 * and a memo-created hub would stay closed for the rest of the page's life.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { useConnection } from '../connection';
import { t } from '../i18n';
import { SessionActivityHub, SessionActivityStore, type SeedFailure, type SessionWorkFacts } from './store';

const EMPTY_STORE = new SessionActivityStore();

function describeSeedFailure(failure: SeedFailure): string {
  switch (failure.kind) {
    case 'envelope':
      return `${String(failure.code)}${failure.message === undefined ? '' : `: ${failure.message}`}`;
    case 'no-items':
      return t('chat.seedNoItems');
    case 'transport':
      return failure.message;
  }
}

export function useSessionActivities(): {
  get(sessionId: string): SessionWorkFacts | undefined;
  seedError: string | null;
} {
  const { baseUrl, config } = useConnection();
  const queryClient = useQueryClient();
  const token = config.token.trim();
  const [hub, setHub] = useState<SessionActivityHub | null>(null);
  const [seedError, setSeedError] = useState<string | null>(null);

  useEffect(() => {
    const created = new SessionActivityHub({
      url: baseUrl,
      token: token === '' ? undefined : token,
      onListChanged: () => {
        void queryClient.invalidateQueries({ queryKey: ['sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['v2-sessions'] });
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
      },
      onSeedError: (failure) => setSeedError(describeSeedFailure(failure)),
    });
    setHub(created);
    setSeedError(null);
    return () => {
      setHub(null);
      created.close();
    };
  }, [baseUrl, token, queryClient]);

  const store = hub?.store ?? EMPTY_STORE;
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getVersion(),
  );
  return {
    get: (sessionId) => store.get(sessionId),
    seedError,
  };
}
