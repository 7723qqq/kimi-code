import { describe, expect, it } from 'bun:test';

import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IFlagService } from '#/app/flag/flag';
import type { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import type { IAtomicDocumentStore } from '#/persistence/interface/atomicDocumentStore';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { SessionNotify } from '#/features/notify/sessionNotify';

function sessionContext(): ISessionContext {
  return { scope: (name: string) => ({ kind: 'scope', name }) } as unknown as ISessionContext;
}

function flags(enabled: boolean): IFlagService {
  return { enabled: () => enabled } as unknown as IFlagService;
}

function bootstrap(capabilities: readonly string[] = ['update_panel']): IBootstrapService {
  return { args: { uiCapabilities: capabilities } } as unknown as IBootstrapService;
}

function store(initial?: { enabled: boolean }): IAtomicDocumentStore & { written: unknown } {
  const handle = {
    written: undefined as unknown,
    get: async () => initial,
    set: async (_scope: unknown, _key: string, value: unknown) => {
      handle.written = value;
    },
  };
  return handle as unknown as IAtomicDocumentStore & { written: unknown };
}

function journal(systemPrompt?: string): IAppendLogStore {
  return {
    async *read() {
      if (systemPrompt === undefined) return;
      yield { type: 'profile.bind', systemPrompt };
    },
  } as unknown as IAppendLogStore;
}

const PROMPT_WITH_NOTIFY =
  'Before you call it: When `NotifyUser` is available, use it proactively to keep the end user informed.';

function notify(
  options: {
    readonly flagEnabled: boolean;
    readonly stored?: { enabled: boolean };
    readonly systemPrompt?: string;
  },
  documentStore = store(options.stored),
): Promise<SessionNotify> {
  const service = new SessionNotify(
    sessionContext(),
    documentStore,
    journal(options.systemPrompt),
    flags(options.flagEnabled),
    bootstrap(),
  );
  return service.ready.then(() => service);
}

describe('SessionNotify', () => {
  it('enables the tool from the flag even when a stored record says it was off', async () => {
    const service = await notify({ flagEnabled: true, stored: { enabled: false } });
    expect(service.enabled).toBe(true);
  });

  it('keeps a session that already had the tool on, after the flag is turned off', async () => {
    const service = await notify({ flagEnabled: false, stored: { enabled: true } });
    expect(service.enabled).toBe(true);
  });

  it('adopts a session whose transcript shows the guidance the tool injects', async () => {
    const service = await notify({
      flagEnabled: false,
      systemPrompt: PROMPT_WITH_NOTIFY,
    });
    expect(service.enabled).toBe(true);
  });

  it('stays off when neither the flag nor the transcript says it was used', async () => {
    const service = await notify({ flagEnabled: false, systemPrompt: 'plain prompt' });
    expect(service.enabled).toBe(false);
  });

  it('refuses the tool when the host does not offer the update panel', async () => {
    const service = new SessionNotify(
      sessionContext(),
      store(),
      journal(),
      flags(true),
      bootstrap([]),
    );
    await service.ready;
    expect(service.enabled).toBe(false);
  });
});
