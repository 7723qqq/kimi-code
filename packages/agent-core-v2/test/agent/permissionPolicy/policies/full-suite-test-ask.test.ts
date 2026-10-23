import type { ToolCall } from '#human/llm/message';
import { describe, expect, it } from 'bun:test';

import { FullSuiteTestAskPermissionPolicyService } from '#/agent/permissionPolicy/policies/full-suite-test-ask';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import { PERMISSION_SECTION } from '#/agent/permissionRules/configSection';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { BashParserService } from '#/app/bashParser/bashParserService';
import type { IConfigService } from '#/app/config/config';
import type { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { stubPermissionModeService } from '../../permissionMode/stubs';

const signal = new AbortController().signal;

const ROOT = process.platform === 'win32' ? 'C:\\workspace' : '/workspace';

function configStub(fullSuiteTestGuard: boolean | undefined): IConfigService {
  return {
    _serviceBrand: undefined,
    get: ((section: string) =>
      section === PERMISSION_SECTION && fullSuiteTestGuard !== undefined
        ? { fullSuiteTestGuard }
        : undefined) as IConfigService['get'],
    onDidSectionChange: (() => ({ dispose: () => {} })) as IConfigService['onDidSectionChange'],
  } as IConfigService;
}

function workspaceStub(workDir: string): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs: [],
    resolve: (path) => path,
    isWithin: () => true,
    assertAllowed: (path) => path,
  };
}

function policyContext(toolName: string, args: unknown): ResolvedToolExecutionHookContext {
  return {
    turnId: '0',
    signal,
    args,
    toolCall: {
      type: 'function',
      id: `call_${toolName}`,
      name: toolName,
      arguments: JSON.stringify(args),
    } satisfies ToolCall,
    toolCalls: [
      {
        type: 'function',
        id: `call_${toolName}`,
        name: toolName,
        arguments: JSON.stringify(args),
      },
    ],
    execution: {
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  } as unknown as ResolvedToolExecutionHookContext;
}

function policy(
  options: {
    readonly mode?: PermissionMode;
    readonly guard?: boolean | undefined;
    readonly workDir?: string;
  } = {},
): FullSuiteTestAskPermissionPolicyService {
  return new FullSuiteTestAskPermissionPolicyService(
    new BashParserService(),
    stubPermissionModeService(() => options.mode ?? 'manual'),
    workspaceStub(options.workDir ?? ROOT),
    configStub('guard' in options ? options.guard : true),
  );
}

function bash(command: string, cwd?: string): ResolvedToolExecutionHookContext {
  return policyContext('Bash', cwd === undefined ? { command } : { command, cwd });
}

describe('FullSuiteTestAskPermissionPolicyService', () => {
  it.each([
    'bun run test',
    'bun run test:watch',
    'bun run test:coverage',
    'bun run test:heavy',
    'bun run test -- --shard=1/5',
    'bun test',
    'bun test --bail',
    'bun scripts/run-tests.mjs',
    'bun ./scripts/run-tests.mjs --shard=1/5',
    'node scripts/run-test-heavy.mjs',
    'npm test',
    'pnpm run test',
    'env CI=1 bun run test',
    "bash -c 'bun run test'",
    'cd packages/agent-core-v2 && cd ../.. && bun run test',
  ])('asks before %s', (command) => {
    const result = policy().evaluate(bash(command));
    expect(result?.kind).toBe('ask');
  });

  it('reports the full-suite invocation as the ask reason', () => {
    expect(policy().evaluate(bash('cd packages/a && cd ../.. && bun run test:heavy'))).toEqual({
      kind: 'ask',
      reason: { full_suite_test_command: 'bun run test:heavy' },
    });
  });

  it.each([
    'bun run test:minidb',
    'bun run build',
    'bun run lint',
    'bun test test/tui',
    'bun test packages/kap-server/test/rpc.test.ts',
    'cd packages/agent-core-v2 && bun run test',
    'cd apps/kimi-code && bun run test',
    'cd packages/agent-core-v2 && bun test',
    'cd packages/agent-core-v2 && node scripts/run-tests.mjs',
    'node scripts/build.mjs',
    'bun run $SCRIPT',
    'echo test',
    'git status',
  ])('leaves %s alone', (command) => {
    expect(policy().evaluate(bash(command))).toBeUndefined();
  });

  it('does not ask when the Bash cwd is already scoped to a package', () => {
    expect(policy().evaluate(bash('bun run test', 'packages/minidb'))).toBeUndefined();
  });

  it('asks when the explicit Bash cwd resolves to the workspace root', () => {
    expect(policy().evaluate(bash('bun run test', '.'))?.kind).toBe('ask');
  });

  it('never asks in Never Ask mode', () => {
    expect(policy({ mode: 'auto' }).evaluate(bash('bun run test'))).toBeUndefined();
  });

  it('asks in Ask When Needed mode', () => {
    expect(policy({ mode: 'yolo' }).evaluate(bash('bun run test'))?.kind).toBe('ask');
  });

  it('does not ask when the guard is disabled', () => {
    expect(policy({ guard: false }).evaluate(bash('bun run test'))).toBeUndefined();
  });

  it('does not ask when the guard setting is absent', () => {
    expect(policy({ guard: undefined }).evaluate(bash('bun run test'))?.kind).toBe('ask');
  });

  it('ignores tools other than Bash', () => {
    expect(policy().evaluate(policyContext('Read', { path: '/workspace/test' }))).toBeUndefined();
  });

  it('ignores a Bash call without a command string', () => {
    expect(policy().evaluate(policyContext('Bash', { timeout: 10 }))).toBeUndefined();
  });

  it('ignores a command it cannot parse', () => {
    expect(policy().evaluate(bash('bun run test | '))).toBeUndefined();
  });
});
