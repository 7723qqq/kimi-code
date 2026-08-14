/**
 * Scenario: sandbox policy resolution and fail-closed enforcement.
 *
 * `resolveSandboxPolicy` maps the `[sandbox]` config section to a per-call
 * execution policy (defaulting to `off`), and until a backend is registered
 * every confined mode must be refused at the execution boundary.
 */

import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import {
  isSandboxBackendAvailable,
  resolveSandboxPolicy,
  SANDBOX_SECTION,
  type SandboxMode,
} from '#/workspace/sandbox/sandbox';

function configWith(mode: SandboxMode | undefined): IConfigService {
  return {
    get: <T>(section: string): T | undefined =>
      section === SANDBOX_SECTION ? ({ mode } as T) : undefined,
  } as unknown as IConfigService;
}

describe('sandbox policy resolution', () => {
  it('defaults to off when the section is absent', () => {
    const policy = resolveSandboxPolicy(configWith(undefined), '/work');
    expect(policy.mode).toBe('off');
    expect(policy.workspaceRoot).toBe('/work');
  });

  it('resolves the configured mode and carries the workspace root', () => {
    const policy = resolveSandboxPolicy(configWith('read-only'), '/work');
    expect(policy.mode).toBe('read-only');
    expect(policy.workspaceRoot).toBe('/work');
  });

  it('resolves workspace-write', () => {
    expect(resolveSandboxPolicy(configWith('workspace-write'), '/work').mode).toBe(
      'workspace-write',
    );
  });

  it('fails closed: no backend is available yet, so confined modes are refused at the boundary', () => {
    // The seam deliberately starts backend-less; the bash tool refuses confined
    // executions until a real isolation backend registers itself here.
    expect(isSandboxBackendAvailable()).toBe(false);
  });
});
