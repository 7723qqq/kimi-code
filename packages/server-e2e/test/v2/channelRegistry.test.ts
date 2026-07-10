/**
 * Drift guard for the server-v2 channel registry.
 *
 * In the VS Code model a registered Service exposes all of its methods by
 * reflection, so the channel registry (keyed by decorator id) *is* the `/api/v2`
 * surface. This test fails if a core channel is accidentally removed or renamed
 * (the decorator id is the public channel name).
 *
 * Note: the legacy SDK resource manifest (public `resource`/`action` names) is
 * no longer cross-checked here — it is being migrated to the decorator-id model
 * separately. Until then this guard pins the server side of the contract.
 */
import { registeredChannelNames } from '@moonshot-ai/kap-server/contract';
import { describe, expect, it } from 'vitest';

describe('v2 server channel registry', () => {
  it('exposes the pinned channels across scopes', () => {
    const names = registeredChannelNames();
    // core
    expect(names).toContain('sessionIndex');
    expect(names).toContain('workspaceRegistry');
    // session
    expect(names).toContain('sessionMetadata');
    // agent (facade-backed)
    expect(names).toContain('agentRPCService');
  });
});
