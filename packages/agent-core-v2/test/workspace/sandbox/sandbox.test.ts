import { describe, expect, it } from 'bun:test';

import type { IConfigService } from '#/app/config/config';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import {
  isSandboxBackendAvailable,
  resolveSandboxPolicy,
  SANDBOX_SECTION,
  sandboxToolVeto,
  sandboxWriteGuard,
  type SandboxMode,
} from '#/workspace/sandbox/sandbox';
import { SandboxPolicyService } from '#/workspace/sandbox/sandboxPolicyService';

import { stubToolExecutorEvents } from '../../agent/toolExecutor/stubs';

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
    expect(error).toContain('[sandbox]');
  });

  it('allows writes inside the workspace in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    expect(sandboxWriteGuard(policy, '/work/file.txt')).toBeUndefined();
    expect(sandboxWriteGuard(policy, '/work/sub/dir/file.txt')).toBeUndefined();
  });

  it('blocks writes outside the workspace in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    const error = sandboxWriteGuard(policy, '/etc/passwd');
    expect(error).toContain('/work');
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

describe('sandboxToolVeto', () => {
  const modes: SandboxMode[] = ['read-only', 'workspace-write'];

  it('allows everything when sandbox is off', () => {
    const policy = resolveSandboxPolicy(configWith('off'), '/work');
    expect(
      sandboxToolVeto(policy, 'Write', 'write', ToolAccesses.writeFile('/work/a')),
    ).toBeUndefined();
    expect(sandboxToolVeto(policy, 'Bash', 'shell', undefined)).toBeUndefined();
    expect(sandboxToolVeto(policy, 'run_code', 'execute', undefined)).toBeUndefined();
    expect(sandboxToolVeto(policy, 'mcp__x', undefined, undefined)).toBeUndefined();
  });

  it('always allows read-class tools in confined modes', () => {
    for (const mode of modes) {
      const policy = resolveSandboxPolicy(configWith(mode), '/work');
      expect(
        sandboxToolVeto(policy, 'Read', 'read', ToolAccesses.readFile('/etc/passwd')),
      ).toBeUndefined();
    }
  });

  it('blocks write-class tools with declared file targets in read-only mode', () => {
    const policy = resolveSandboxPolicy(configWith('read-only'), '/work');
    const error = sandboxToolVeto(policy, 'Write', 'write', ToolAccesses.writeFile('/work/a'));
    expect(error).toContain('read-only');
    expect(error).toContain('[sandbox]');
  });

  it('blocks write-class tools without declared file targets in read-only mode', () => {
    const policy = resolveSandboxPolicy(configWith('read-only'), '/work');
    const error = sandboxToolVeto(policy, 'TaskStop', 'write', ToolAccesses.none());
    expect(error).toContain('TaskStop');
    expect(error).toContain('read-only');
  });

  it('blocks write-class tools that declare no accesses at all in read-only mode', () => {
    const policy = resolveSandboxPolicy(configWith('read-only'), '/work');
    expect(sandboxToolVeto(policy, 'Memory', 'write', undefined)).toContain('Memory');
  });

  it('allows in-workspace writes in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    expect(
      sandboxToolVeto(policy, 'Write', 'write', ToolAccesses.writeFile('/work/sub/a.ts')),
    ).toBeUndefined();
    expect(
      sandboxToolVeto(policy, 'Edit', 'write', ToolAccesses.readWriteFile('/work/b.ts')),
    ).toBeUndefined();
  });

  it('blocks out-of-workspace writes in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    const error = sandboxToolVeto(policy, 'Write', 'write', ToolAccesses.writeFile('/etc/x'));
    expect(error).toContain('/work');
    expect(error).toContain('/etc/x');
  });

  it('blocks write-class tools without verifiable targets in workspace-write mode', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    const error = sandboxToolVeto(policy, 'CronCreate', 'write', ToolAccesses.none());
    expect(error).toContain('CronCreate');
    expect(error).toContain('fail closed');
  });

  it('blocks shell tools in read-only mode because commands cannot be proven write-free', () => {
    const policy = resolveSandboxPolicy(configWith('read-only'), '/work');
    const error = sandboxToolVeto(policy, 'Bash', 'shell', undefined);
    expect(error).toContain('Bash');
    expect(error).toContain('[sandbox]');
  });

  it('blocks shell tools in workspace-write mode when no OS backend exists (fail closed)', () => {
    const policy = resolveSandboxPolicy(configWith('workspace-write'), '/work');
    const error = sandboxToolVeto(policy, 'PowerShell', 'shell', undefined);
    expect(error).toContain('PowerShell');
    expect(error).toContain('fail closed');
  });

  it('blocks code execution in both confined modes', () => {
    for (const mode of modes) {
      const policy = resolveSandboxPolicy(configWith(mode), '/work');
      expect(sandboxToolVeto(policy, 'run_code', 'execute', undefined)).toContain('run_code');
    }
  });

  it('blocks tools that do not declare a side-effect class (fail closed)', () => {
    for (const mode of modes) {
      const policy = resolveSandboxPolicy(configWith(mode), '/work');
      const error = sandboxToolVeto(policy, 'mcp__server__tool', undefined, undefined);
      expect(error).toContain('mcp__server__tool');
      expect(error).toContain('fail closed');
    }
  });
});

describe('SandboxPolicyService', () => {
  function hookContext(
    toolName: string,
    tool: ExecutableTool | undefined,
    accesses: ReturnType<typeof ToolAccesses.writeFile> | undefined,
  ): ResolvedToolExecutionHookContext {
    return {
      turnId: 0,
      signal: new AbortController().signal,
      toolCall: { type: 'function', id: 'call_1', name: toolName, arguments: '{}' },
      toolCalls: [{ type: 'function', id: 'call_1', name: toolName, arguments: '{}' }],
      tool,
      args: {},
      execution: {
        approvalRule: toolName,
        accesses,
        execute: async () => ({ output: 'ran' }),
      },
    };
  }

  function serviceFor(mode: SandboxMode) {
    const stubs = stubToolExecutorEvents();
    const config = configWith(mode);
    const sessionCtx = { _serviceBrand: undefined, cwd: '/work' } as unknown as ISessionContext;
    const service = new SandboxPolicyService(config, sessionCtx, stubs.executor);
    return { service, stubs };
  }

  it('vetoes a write tool under read-only before it executes', async () => {
    const { service, stubs } = serviceFor('read-only');
    const tool = { name: 'Write', sideEffect: 'write' } as unknown as ExecutableTool;
    const decision = await stubs.fireBeforeExecute(
      hookContext('Write', tool, ToolAccesses.writeFile('/work/a.ts')),
    );
    expect(decision?.veto?.isError).toBe(true);
    expect(decision?.veto?.output).toContain('read-only');
    service.dispose();
  });

  it('lets a read tool through under read-only', async () => {
    const { service, stubs } = serviceFor('read-only');
    const tool = { name: 'Read', sideEffect: 'read' } as unknown as ExecutableTool;
    const decision = await stubs.fireBeforeExecute(
      hookContext('Read', tool, ToolAccesses.readFile('/etc/passwd')),
    );
    expect(decision).toBeUndefined();
    service.dispose();
  });

  it('vetoes shell tools under read-only', async () => {
    const { service, stubs } = serviceFor('read-only');
    const tool = { name: 'Bash', sideEffect: 'shell' } as unknown as ExecutableTool;
    const decision = await stubs.fireBeforeExecute(hookContext('Bash', tool, undefined));
    expect(decision?.veto?.isError).toBe(true);
    service.dispose();
  });

  it('does not subscribe at all when sandbox is off', async () => {
    const { service, stubs } = serviceFor('off');
    const tool = { name: 'Write', sideEffect: 'write' } as unknown as ExecutableTool;
    const decision = await stubs.fireBeforeExecute(
      hookContext('Write', tool, ToolAccesses.writeFile('/work/a.ts')),
    );
    expect(decision).toBeUndefined();
    service.dispose();
  });

  it('allows an in-workspace write and vetoes an out-of-workspace write under workspace-write', async () => {
    const { service, stubs } = serviceFor('workspace-write');
    const tool = { name: 'Write', sideEffect: 'write' } as unknown as ExecutableTool;
    const inside = await stubs.fireBeforeExecute(
      hookContext('Write', tool, ToolAccesses.writeFile('/work/ok.ts')),
    );
    expect(inside).toBeUndefined();
    const outside = await stubs.fireBeforeExecute(
      hookContext('Write', tool, ToolAccesses.writeFile('/etc/evil')),
    );
    expect(outside?.veto?.isError).toBe(true);
    service.dispose();
  });
});
