import { describe, expect, it } from 'vitest';

import type { IConfigService } from '#/app/config/config';
import {
  isSandboxBackendAvailable,
  resolveSandboxPolicy,
  SANDBOX_SECTION,
  sandboxWriteGuard,
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
    expect(isSandboxBackendAvailable()).toBe(false);
  });
});

describe('sandboxWriteGuard', () => {
  it('allows writes when sandbox is off', () => {
    const policy = resolveSandboxPolicy(configWith('off'), '/work');
    expect(sandboxWriteGuard(policy, '/work/file.txt')).toBeUndefined();
  });

  it('blocks every write in read-only mode', () => {
    const policy = resolveSandboxPolicy(configWith('read-only'), '/work');
    const error = sandboxWriteGuard(policy, '/work/file.txt');
    expect(error).toContain('read-only');
    expect(error).toContain('blocks writes');
  });

  it('allows writes inside the workspace in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    expect(sandboxWriteGuard(policy, '/work/file.txt')).toBeUndefined();
    expect(sandboxWriteGuard(policy, '/work/sub/dir/file.txt')).toBeUndefined();
  });

  it('blocks writes outside the workspace in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    const error = sandboxWriteGuard(policy, '/etc/passwd');
    expect(error).toContain('outside the workspace');
    expect(error).toContain('/etc/passwd');
  });

  it('does not confuse a sibling directory with the workspace root', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    expect(sandboxWriteGuard(policy, '/work2/file.txt')).not.toBeUndefined();
  });

  it('treats a drive-letter case difference as inside the workspace on Windows paths', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), 'C:/work');
    expect(sandboxWriteGuard(policy, 'c:/work/file.txt')).toBeUndefined();
  });
});
