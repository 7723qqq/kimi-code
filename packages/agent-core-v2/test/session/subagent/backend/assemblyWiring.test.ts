import { describe, expect, it } from 'bun:test';

import { getScopedServiceDescriptors } from '#/_base/di/scope';
import { getConfigSectionContributions } from '#/app/config/configSectionContributions';
import { getContributedFlags } from '#/app/flag/flagRegistry';
import { LifecycleScope } from '#/app/scopes';
import { ISubagentBackendService } from '#/session/subagent/backend/subagentBackend';

describe('subagent backend assembly wiring', () => {
  it('registers the backend service, config section and flag from the domain assembly', async () => {
    await import('#/index');

    const serviceEntry = getScopedServiceDescriptors(LifecycleScope.Session).find(
      (entry) => entry.id === ISubagentBackendService,
    );
    expect(serviceEntry?.domain).toBe('subagent');

    expect(getConfigSectionContributions().some((entry) => entry.domain === 'subagentBackend')).toBe(
      true,
    );

    expect(getContributedFlags().some((flag) => flag.id === 'subagent_backends')).toBe(true);
  }, 60_000);
});
