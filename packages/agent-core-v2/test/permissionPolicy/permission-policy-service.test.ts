import type { ToolCall } from '@moonshot-ai/kosong';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHooks } from '#/hooks';
import type { Hooks } from '#/hooks';
import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import {
  literalRulePattern,
  matchesGlobRuleSubject,
  matchesPathRuleSubject,
} from '#/_base/tools/support/rule-match';
import type { ResolvedToolExecutionHookContext } from '#/loop';
import { IPermissionModeService } from '#/permissionMode';
import {
  IPermissionPolicyService,
  type PermissionMode,
  type PermissionPolicyEvaluation,
} from '#/permissionPolicy';
import { PermissionPolicyService } from '#/permissionPolicy/permissionPolicyService';
import {
  IPermissionRulesService,
  type IPermissionRulesService as PermissionRulesServiceContract,
  type PermissionApprovalResultRecord,
  type PermissionRule,
} from '#/permissionRules';
import { IProfileService, type ProfileData } from '#/profile';
import { ITelemetryService } from '#/telemetry';
import { ToolAccesses, type ToolAccesses as ToolAccessList } from '#/_base/tools';

import { stubPermissionModeService } from '../permissionMode/stubs';
import { recordingTelemetry } from '../telemetry/stubs';

const signal = new AbortController().signal;

describe('PermissionPolicyService chain', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let rules: PermissionRule[];
  let sessionApprovalRulePatterns: string[];

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'manual';
    rules = [];
    sessionApprovalRulePatterns = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IPermissionRulesService, permissionRulesStub({
          rules: () => rules,
          sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
        }));
        reg.definePartialInstance(IProfileService, {
          data: () => ({ cwd: '/workspace' }) as ProfileData,
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.define(IPermissionPolicyService, PermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  function service(): IPermissionPolicyService {
    return ix.get(IPermissionPolicyService);
  }

  async function evaluate(
    input: PolicyContextInput,
    options: Parameters<IPermissionPolicyService['configure']>[0] = {},
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = service();
    svc.configure(options);
    return svc.evaluate(policyContext(input));
  }

  it('keeps auto-mode AskUserQuestion deny above default approval', async () => {
    mode = 'auto';

    await expect(evaluate({
      toolName: 'AskUserQuestion',
      args: { questions: [] },
    })).resolves.toMatchObject({
      policyName: 'auto-mode-ask-user-question-deny',
      result: { kind: 'deny' },
    });
  });

  it('denies invalid AgentSwarm batches before auto-mode approval', async () => {
    mode = 'auto';
    const agentSwarmArgs = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    };
    const agentSwarmCall = toolCall('call_agent_swarm', 'AgentSwarm', agentSwarmArgs);
    const readCall = toolCall('call_read', 'Read', { path: 'src/a.ts' });

    await expect(evaluate({
      toolName: 'AgentSwarm',
      args: agentSwarmArgs,
      toolCall: agentSwarmCall,
      toolCalls: [agentSwarmCall, readCall],
    })).resolves.toMatchObject({
      policyName: 'agent-swarm-exclusive-deny',
      result: {
        kind: 'deny',
        reason: {
          agent_swarm_tool_calls: 1,
          tool_calls: 2,
        },
      },
    });
  });

  it('applies deny rules before yolo-mode approval', async () => {
    mode = 'yolo';
    rules.push({
      decision: 'deny',
      scope: 'user',
      pattern: 'Bash',
      reason: 'blocked by test',
    });

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-deny',
      result: {
        kind: 'deny',
        message: 'Tool "Bash" was denied by permission rule. Reason: blocked by test',
      },
    });
  });

  it('keeps ask rules higher priority than matching allow rules', async () => {
    rules.push(
      {
        decision: 'allow',
        scope: 'project',
        pattern: 'Bash',
      },
      {
        decision: 'ask',
        scope: 'user',
        pattern: 'Bash',
      },
    );

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'user-configured-ask',
      result: { kind: 'ask' },
    });
  });

  it('reuses approve-for-session before matching ask rules', async () => {
    rules.push({
      decision: 'ask',
      scope: 'user',
      pattern: 'Bash',
    });
    sessionApprovalRulePatterns.push('Bash(printf first)');

    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'session-approval-history',
      result: {
        kind: 'approve',
        reason: {
          has_rule_args: true,
          match_strategy: 'matches_rule',
        },
      },
    });
  });
});

describe('PermissionPolicyService plan-mode policies', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let sessionApprovalRulePatterns: string[];

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'manual';
    sessionApprovalRulePatterns = [];
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IPermissionRulesService, permissionRulesStub({
          sessionApprovalRulePatterns: () => sessionApprovalRulePatterns,
        }));
        reg.definePartialInstance(IProfileService, {
          data: () => ({ cwd: '/workspace' }) as ProfileData,
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.define(IPermissionPolicyService, PermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  async function evaluate(
    input: PolicyContextInput,
    options: Parameters<IPermissionPolicyService['configure']>[0] = {},
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = ix.get(IPermissionPolicyService);
    svc.configure(options);
    return svc.evaluate(policyContext(input));
  }

  it('approves EnterPlanMode in manual mode', async () => {
    await expect(evaluate({ toolName: 'EnterPlanMode', args: {} })).resolves.toMatchObject({
      policyName: 'plan-mode-tool-approve',
      result: { kind: 'approve' },
    });
  });

  it.each(['Write', 'Edit'] as const)(
    'approves %s when it only writes the active plan file',
    async (toolName) => {
      const planFilePath = '/workspace/.kimi/plans/current.md';
      await expect(evaluate({
        toolName,
        args: toolName === 'Write'
          ? { path: planFilePath, content: '# Plan' }
          : { path: planFilePath, old_string: '# Draft', new_string: '# Plan' },
        accesses: toolName === 'Write'
          ? ToolAccesses.writeFile(planFilePath)
          : ToolAccesses.readWriteFile(planFilePath),
      }, {
        planMode: planModeState({ isActive: true, planFilePath }),
      })).resolves.toMatchObject({
        policyName: 'plan-mode-tool-approve',
        result: { kind: 'approve' },
      });
    },
  );

  it('denies active plan-mode writes that have no file write access', async () => {
    const planFilePath = '/workspace/.kimi/plans/current.md';

    await expect(evaluate({
      toolName: 'Write',
      args: { path: planFilePath, content: '# Plan' },
      accesses: ToolAccesses.none(),
    }, {
      planMode: planModeState({ isActive: true, planFilePath }),
    })).resolves.toMatchObject({
      policyName: 'plan-mode-guard-deny',
      result: {
        kind: 'deny',
        message: expect.stringContaining('Plan mode is active'),
      },
    });
  });

  it('approves ExitPlanMode directly when plan mode is inactive', async () => {
    await expect(evaluate({
      toolName: 'ExitPlanMode',
      args: {},
      display: planReviewDisplay({ plan: '# Plan' }),
    }, {
      planMode: planModeState({ isActive: false, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'plan-mode-tool-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves ExitPlanMode while active when there is no plan review display', async () => {
    await expect(evaluate({
      toolName: 'ExitPlanMode',
      args: {},
      display: { kind: 'generic', summary: 'exit', detail: {} },
    }, {
      planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'plan-mode-tool-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves ExitPlanMode while active when the plan review is blank', async () => {
    await expect(evaluate({
      toolName: 'ExitPlanMode',
      args: {},
      display: planReviewDisplay({ plan: '  \n\t' }),
    }, {
      planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'plan-mode-tool-approve',
      result: { kind: 'approve' },
    });
  });

  it('defers non-empty plan reviews to the review approval policy in manual mode', async () => {
    await expect(evaluate({
      toolName: 'ExitPlanMode',
      args: {},
      display: planReviewDisplay({ plan: '# Plan' }),
    }, {
      planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'exit-plan-mode-review-ask',
      result: { kind: 'ask' },
    });
  });

  it('requests plan-review approval in yolo mode', async () => {
    mode = 'yolo';

    await expect(evaluate({
      toolName: 'ExitPlanMode',
      args: {},
      display: planReviewDisplay({ plan: '# Plan' }),
    }, {
      planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'exit-plan-mode-review-ask',
      result: { kind: 'ask' },
    });
  });

  it('reuses session approval for ExitPlanMode without re-prompting plan review', async () => {
    sessionApprovalRulePatterns.push('ExitPlanMode');

    await expect(evaluate({
      toolName: 'ExitPlanMode',
      args: {},
      display: planReviewDisplay({ plan: '# Updated Plan' }),
    }, {
      planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'session-approval-history',
      result: { kind: 'approve' },
    });
  });

  it('uses ordinary Bash approval in manual plan mode', async () => {
    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'ls -la', timeout: 60 },
    }, {
      planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it.each([
    ['auto', 'auto-mode-approve'],
    ['yolo', 'yolo-mode-approve'],
  ] as const)(
    'defers Bash to ordinary %s permission behavior in plan mode',
    async (nextMode, policyName) => {
      mode = nextMode;
      await expect(evaluate({
        toolName: 'Bash',
        args: { command: 'rm generated.txt', timeout: 60 },
      }, {
        planMode: planModeState({ isActive: true, planFilePath: '/tmp/plan.md' }),
      })).resolves.toMatchObject({
        policyName,
        result: { kind: 'approve' },
      });
    },
  );
});

describe('PermissionPolicyService git cwd write approval', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let mode: PermissionMode;
  let gitWorkTreeMarker: NonNullable<
    Parameters<IPermissionPolicyService['configure']>[0]['gitWorkTreeMarker']
  >;

  beforeEach(() => {
    disposables = new DisposableStore();
    mode = 'manual';
    gitWorkTreeMarker = vi.fn(() => ({
      dotGitPath: '/workspace/.git',
      controlDirPath: '/workspace/.git',
    }));
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IPermissionModeService, stubPermissionModeService(() => mode));
        reg.definePartialInstance(IPermissionRulesService, permissionRulesStub());
        reg.definePartialInstance(IProfileService, {
          data: () => ({ cwd: '/workspace' }) as ProfileData,
        });
        reg.defineInstance(ITelemetryService, recordingTelemetry([]));
        reg.define(IPermissionPolicyService, PermissionPolicyService);
      },
      strict: true,
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  async function evaluate(
    input: PolicyContextInput,
    options: Parameters<IPermissionPolicyService['configure']>[0] = {},
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const svc = ix.get(IPermissionPolicyService);
    svc.configure({
      cwd: '/workspace',
      pathClass: 'posix',
      gitWorkTreeMarker,
      ...options,
    });
    return svc.evaluate(policyContext(input));
  }

  it('still asks for Bash inside a git cwd in manual mode', async () => {
    await expect(evaluate({
      toolName: 'Bash',
      args: { command: 'printf first', timeout: 60 },
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
    expect(gitWorkTreeMarker).not.toHaveBeenCalled();
  });

  it('approves Write to a path inside the git cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile('/workspace/src/a.ts'),
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('approves Edit on an additionalDir path in manual mode', async () => {
    await expect(evaluate({
      toolName: 'Edit',
      args: { path: '/extra/src/a.ts', old_string: 'A', new_string: 'B' },
      accesses: ToolAccesses.readWriteFile('/extra/src/a.ts'),
    }, {
      additionalDirs: ['/extra'],
    })).resolves.toMatchObject({
      policyName: 'git-cwd-write-approve',
      result: { kind: 'approve' },
    });
  });

  it('asks for paths outside cwd and additionalDirs', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '/extra-evil/outside.ts', content: 'x' },
      accesses: ToolAccesses.writeFile('/extra-evil/outside.ts'),
    }, {
      additionalDirs: ['/extra'],
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for git control files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.git/config', content: 'x' },
      accesses: ToolAccesses.writeFile('/workspace/.git/config'),
    })).resolves.toMatchObject({
      policyName: 'git-control-path-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('asks for sensitive files before git-cwd approval', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: '.env', content: 'SECRET=1' },
      accesses: ToolAccesses.writeFile('/workspace/.env'),
    })).resolves.toMatchObject({
      policyName: 'sensitive-file-access-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not use git-cwd approval in auto mode', async () => {
    mode = 'auto';
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.writeFile('/workspace/src/a.ts'),
    })).resolves.toMatchObject({
      policyName: 'auto-mode-approve',
      result: { kind: 'approve' },
    });
  });

  it('does not approve Write when execution has no write file access', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: ToolAccesses.none(),
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });

  it('does not approve when any write access is outside the cwd', async () => {
    await expect(evaluate({
      toolName: 'Write',
      args: { path: 'src/a.ts', content: 'x' },
      accesses: [
        { kind: 'file', operation: 'write', path: '/workspace/src/a.ts' },
        { kind: 'file', operation: 'write', path: '/tmp/outside.ts' },
      ],
    })).resolves.toMatchObject({
      policyName: 'fallback-ask',
      result: { kind: 'ask' },
    });
  });
});

interface MutablePermissionRulesStubOptions {
  readonly rules?: () => readonly PermissionRule[];
  readonly sessionApprovalRulePatterns?: () => readonly string[];
}

function permissionRulesStub(
  options: MutablePermissionRulesStubOptions = {},
): Partial<PermissionRulesServiceContract> {
  const rules = options.rules ?? (() => []);
  const sessionApprovalRulePatterns = options.sessionApprovalRulePatterns ?? (() => []);
  return {
    get rules() {
      return rules();
    },
    get sessionApprovalRulePatterns() {
      return sessionApprovalRulePatterns();
    },
    addRules: () => {},
    recordApprovalResult: () => {},
    hooks: createHooks(['onChanged', 'onApprovalRecorded']) as Hooks<{
      onChanged: { rules: readonly PermissionRule[] };
      onApprovalRecorded: { record: PermissionApprovalResultRecord };
    }>,
  };
}

interface PolicyContextInput {
  readonly id?: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly toolCall?: ToolCall;
  readonly toolCalls?: readonly ToolCall[];
  readonly display?: ToolInputDisplay;
  readonly accesses?: ToolAccessList;
}

function policyContext(input: PolicyContextInput): ResolvedToolExecutionHookContext {
  const toolCall =
    input.toolCall ??
    toolCallFor(input.id ?? `call_${input.toolName}`, input.toolName, input.args);
  const subject = ruleSubject(input.toolName, input.args);
  return {
    turnId: '0',
    signal,
    toolCall,
    toolCalls: input.toolCalls ?? [toolCall],
    args: input.args,
    execution: {
      description: description(input.toolName),
      display: input.display ?? display(input.toolName, input.args),
      accesses: input.accesses ?? accesses(input.toolName, input.args),
      approvalRule:
        subject === undefined ? input.toolName : literalRulePattern(input.toolName, subject),
      matchesRule:
        subject === undefined
          ? undefined
          : (ruleArgs) => matchesRuleSubject(input.toolName, ruleArgs, subject),
      execute: async () => ({ output: '' }),
    },
  };
}

function toolCallFor(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id,
    name,
    arguments: JSON.stringify(args),
  };
}

function toolCall(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return toolCallFor(id, name, args);
}

function ruleSubject(toolName: string, args: Record<string, unknown>): string | undefined {
  switch (toolName) {
    case 'Bash':
      return stringArg(args, 'command');
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return stringArg(args, 'path');
    case 'Grep':
    case 'Glob':
      return stringArg(args, 'pattern');
    default:
      return undefined;
  }
}

function matchesRuleSubject(toolName: string, ruleArgs: string, subject: string): boolean {
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
    case 'Write':
    case 'Edit':
      return matchesPathRuleSubject(ruleArgs, subject, { cwd: '/workspace', pathClass: 'posix' });
    default:
      return matchesGlobRuleSubject(ruleArgs, subject);
  }
}

function description(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'run command';
    case 'Write':
      return 'write file';
    case 'Edit':
      return 'edit file';
    case 'ExitPlanMode':
      return 'Presenting plan and exiting plan mode';
    default:
      return `Approve ${toolName}`;
  }
}

function display(toolName: string, args: Record<string, unknown>): ToolInputDisplay {
  const path = stringArg(args, 'path', '/workspace/file.txt');
  switch (toolName) {
    case 'Bash':
      return { kind: 'command', command: stringArg(args, 'command') };
    case 'Read':
    case 'ReadMediaFile':
      return { kind: 'file_io', operation: 'read', path };
    case 'Write':
      return { kind: 'file_io', operation: 'write', path };
    case 'Edit':
      return { kind: 'file_io', operation: 'edit', path };
    default:
      return { kind: 'generic', summary: `Approve ${toolName}`, detail: args };
  }
}

function accesses(toolName: string, args: Record<string, unknown>): ToolAccessList {
  const path = stringArg(args, 'path');
  switch (toolName) {
    case 'Read':
    case 'ReadMediaFile':
      return path.length > 0 ? ToolAccesses.readFile(path) : ToolAccesses.none();
    case 'Write':
      return path.length > 0 ? ToolAccesses.writeFile(path) : ToolAccesses.none();
    case 'Edit':
      return path.length > 0 ? ToolAccesses.readWriteFile(path) : ToolAccesses.none();
    case 'Grep':
    case 'Glob':
      return path.length > 0 ? ToolAccesses.searchTree(path) : ToolAccesses.none();
    default:
      return ToolAccesses.none();
  }
}

function stringArg(
  args: Record<string, unknown>,
  key: string,
  fallback = '',
): string {
  const value = args[key];
  return typeof value === 'string' ? value : fallback;
}

function planModeState(input: {
  readonly isActive: boolean;
  readonly planFilePath: string | null;
}): Parameters<IPermissionPolicyService['configure']>[0]['planMode'] {
  return {
    isActive: input.isActive,
    planFilePath: input.planFilePath,
    exit: () => {},
  };
}

function planReviewDisplay(input: { readonly plan: string }): ToolInputDisplay {
  return {
    kind: 'plan_review',
    plan: input.plan,
    path: '/tmp/plan.md',
  };
}
