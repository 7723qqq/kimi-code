import { beforeEach, describe, expect, it } from 'vitest';

import { createDecorator } from '#/_base/di/instantiation';
import { LifecycleScope } from '#/app/scopes';
import {
  ScopeActivation,
  _clearScopedRegistryForTests,
  getScopedServiceDescriptors,
  registerScopedService,
} from '#/_base/di/scope';

interface IApp {
  tag: 'app';
}
interface ISession {
  tag: 'session';
}
interface IAgent {
  tag: 'agent';
}

const IApp = createDecorator<IApp>('scoped-app');
const ISession = createDecorator<ISession>('scoped-session');
const IAgent = createDecorator<IAgent>('scoped-agent');

class AppSvc implements IApp {
  tag = 'app' as const;
}
class SessionSvc implements ISession {
  tag = 'session' as const;
}
class AgentSvc implements IAgent {
  tag = 'agent' as const;
}

describe('registerScopedService / getScopedServiceDescriptors', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
  });

  it('uses stable activation values', () => {
    expect(ScopeActivation.OnScopeCreated).toBe(0);
    expect(ScopeActivation.OnDemand).toBe(1);
  });

  it('filters registrations by scope layer', () => {
    registerScopedService(
      LifecycleScope.App,
      IApp,
      AppSvc,
      ScopeActivation.OnDemand,
      'app-domain',
    );
    registerScopedService(
      LifecycleScope.Session,
      ISession,
      SessionSvc,
      ScopeActivation.OnDemand,
      'session-domain',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgent,
      AgentSvc,
      ScopeActivation.OnScopeCreated,
      'agent-domain',
    );

    expect(getScopedServiceDescriptors(LifecycleScope.App).map((e) => e.id)).toEqual([IApp]);
    expect(getScopedServiceDescriptors(LifecycleScope.Session).map((e) => e.id)).toEqual([ISession]);
    expect(getScopedServiceDescriptors(LifecycleScope.Agent).map((e) => e.id)).toEqual([IAgent]);
  });

  it('records domain and scope activation', () => {
    registerScopedService(
      LifecycleScope.Session,
      ISession,
      SessionSvc,
      ScopeActivation.OnDemand,
      'session-domain',
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgent,
      AgentSvc,
      ScopeActivation.OnScopeCreated,
      'agent-domain',
    );

    const [sessionEntry] = getScopedServiceDescriptors(LifecycleScope.Session);
    const [agentEntry] = getScopedServiceDescriptors(LifecycleScope.Agent);

    expect(sessionEntry?.domain).toBe('session-domain');
    expect(sessionEntry?.activation).toBe(ScopeActivation.OnDemand);
    expect(agentEntry?.domain).toBe('agent-domain');
    expect(agentEntry?.activation).toBe(ScopeActivation.OnScopeCreated);
  });

  it('allows the same id to coexist at different scopes', () => {
    interface IDual {
      tag: string;
    }
    const IDual = createDecorator<IDual>('scoped-dual');
    class AppDual implements IDual {
      tag = 'app';
    }
    class SessionDual implements IDual {
      tag = 'session';
    }
    registerScopedService(LifecycleScope.App, IDual, AppDual);
    registerScopedService(LifecycleScope.Session, IDual, SessionDual);

    expect(getScopedServiceDescriptors(LifecycleScope.App)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.Session)).toHaveLength(1);
    expect(getScopedServiceDescriptors(LifecycleScope.App)[0]?.id).toBe(IDual);
    expect(getScopedServiceDescriptors(LifecycleScope.Session)[0]?.id).toBe(IDual);
  });

  it('register without domain still records the service', () => {
    registerScopedService(LifecycleScope.App, IApp, AppSvc);
    const entries = getScopedServiceDescriptors(LifecycleScope.App);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.id).toBe(IApp);
  });

  it('register with eager vs on-demand activation both work', () => {
    registerScopedService(LifecycleScope.App, IApp, AppSvc, ScopeActivation.OnScopeCreated);
    registerScopedService(LifecycleScope.Session, ISession, SessionSvc, ScopeActivation.OnDemand);
    const appEntries = getScopedServiceDescriptors(LifecycleScope.App);
    const sessionEntries = getScopedServiceDescriptors(LifecycleScope.Session);
    expect(appEntries[0]?.activation).toBe(ScopeActivation.OnScopeCreated);
    expect(sessionEntries[0]?.activation).toBe(ScopeActivation.OnDemand);
  });

  it('getScopedServiceDescriptors for a scope with no registrations returns empty', () => {
    expect(getScopedServiceDescriptors(LifecycleScope.Agent)).toEqual([]);
  });
});
