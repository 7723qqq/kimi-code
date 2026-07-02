/**
 * Scenario: the **permission** slice — `IAgentPermissionGate` composing
 * policy, mode, and rules into an allow/deny decision.
 *
 * Concept taught: the permission gate is a **chain-of-responsibility**. When a
 * tool is about to run, `IAgentPermissionGate.authorize(context)` delegates the
 * decision to `IAgentPermissionPolicyService`, which walks an ordered list of
 * policies and returns the first verdict. The verdict is driven by two other
 * Agent-scope services the gate also depends on:
 *
 *   - `IAgentPermissionModeService` — the top-level posture (`manual` / `yolo`
 *     / `auto`). `yolo` approves almost everything; `manual` lets the rule set
 *     decide.
 *   - `IAgentPermissionRulesService` — the user/session rules. A `deny` rule
 *     always fires, regardless of mode; an `allow` rule approves a match.
 *
 * The full built-in policy chain (`AgentPermissionPolicyService`) constructs
 * ~18 policies that reach into git, plan, swarm, workspace, and other domains —
 * far more wiring than a teaching example needs. So this example registers the
 * **real** gate, mode, and rules services, but seeds a tiny in-file
 * `IAgentPermissionPolicyService` that mimics the chain by reading the *real*
 * mode + rules services. That keeps the decision honest: changing a real rule
 * on the real rules service flips the real gate's verdict.
 *
 * Prerequisites: example 01 (container & scope tree), example 03 (host seeds).
 *
 * Run:
 *   pnpm --filter @moonshot-ai/agent-core-v2 example -- examples/permission.example.ts
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { SyncDescriptor } from '#/_base/di';
import {
  LifecycleScope,
  _clearScopedRegistryForTests,
  registerScopedService,
} from '#/_base/di/scope';
import { createScopedTestHost, stubPair } from '#/_base/di/test';

import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import {
  AgentPermissionGate,
  IAgentPermissionGate,
} from '#/agent/permissionGate';
import {
  AgentPermissionModeService,
  IAgentPermissionModeService,
} from '#/agent/permissionMode';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
  type PermissionRuleDecision,
} from '#/agent/permissionPolicy';
import {
  AgentPermissionRulesService,
  IAgentPermissionRulesService,
  matchPermissionRule,
} from '#/agent/permissionRules';
import { IAgentRecordService } from '#/agent/record';
import {
  type ResolvedToolExecutionHookContext,
} from '#/agent/tool';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry';
import { ISessionContext } from '#/session/sessionContext';

// --- Leaf fakes for collaborators outside the slice -----------------------
// The gate/mode/rules constructors only *touch* these surfaces; everything
// else is cast away. `record.define` / `contextInjector.register` must return
// a disposable because the real services `_register(...)` them.
const fakeRecord = {
  define: () => ({ dispose: () => {} }),
  append: () => {},
} as unknown as IAgentRecordService;

const fakeContextInjector = {
  register: () => ({ dispose: () => {} }),
} as unknown as IAgentContextInjectorService;

const fakeToolExecutor = {
  hooks: {
    onWillExecuteTool: { register: () => ({ dispose: () => {} }) },
    onDidExecuteTool: { register: () => ({ dispose: () => {} }) },
  },
} as unknown as IAgentToolExecutorService;

const fakeExternalHooks = {} as unknown as IAgentExternalHooksService;

const fakeSession = {
  sessionId: 's1',
  workspaceId: 'ws1',
  sessionDir: '/tmp/s1',
  metaScope: 'test',
} as unknown as ISessionContext;

// --- A tiny in-file policy chain ------------------------------------------
// Mirrors the precedence of the real built-ins that read mode + rules:
//   1. a matching user `deny` rule always fires (regardless of mode);
//   2. `yolo` mode approves everything not denied;
//   3. a matching user `allow` rule approves;
//   4. otherwise no decision (the gate treats `undefined` as "allow").
const USER_RULE_SCOPES = new Set(['turn-override', 'project', 'user']);

function matchingUserRule(
  context: ResolvedToolExecutionHookContext,
  decision: PermissionRuleDecision,
  rules: IAgentPermissionRulesService,
) {
  for (const rule of rules.rules) {
    if (!USER_RULE_SCOPES.has(rule.scope)) continue;
    if (rule.decision !== decision) continue;
    if (
      matchPermissionRule({
        rule,
        toolName: context.toolCall.name,
        execution: context.execution,
      }) !== undefined
    ) {
      return rule;
    }
  }
  return undefined;
}

class RuleBasedPermissionPolicy implements IAgentPermissionPolicyService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentPermissionModeService
    private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService
    private readonly rulesService: IAgentPermissionRulesService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    if (matchingUserRule(context, 'deny', this.rulesService) !== undefined) {
      return {
        policyName: 'example-user-deny',
        result: {
          kind: 'deny',
          message: `Tool "${context.toolCall.name}" was denied by permission rule.`,
        },
      };
    }
    if (this.modeService.mode === 'yolo') {
      return { policyName: 'example-yolo', result: { kind: 'approve' } };
    }
    if (matchingUserRule(context, 'allow', this.rulesService) !== undefined) {
      return { policyName: 'example-user-allow', result: { kind: 'approve' } };
    }
    return undefined;
  }

  registerPolicy() {
    return { dispose: () => {} };
  }
}

// --- Helper: build the smallest valid tool-execution context --------------
function toolContext(toolName: string): ResolvedToolExecutionHookContext {
  const toolCall = {
    type: 'function' as const,
    id: `tc-${toolName}`,
    name: toolName,
    arguments: null,
  };
  return {
    turnId: '1',
    signal: new AbortController().signal,
    toolCall,
    toolCalls: [toolCall],
    args: {},
    execution: {
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

describe('permission slice (gate composing policy + mode + rules)', () => {
  beforeEach(() => {
    _clearScopedRegistryForTests();
    // The three real services of the slice. The heavy built-in policy chain is
    // replaced by the tiny `RuleBasedPermissionPolicy` above, which still reads
    // the real mode + rules services.
    registerScopedService(
      LifecycleScope.Agent,
      IAgentPermissionModeService,
      AgentPermissionModeService,
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgentPermissionRulesService,
      AgentPermissionRulesService,
    );
    registerScopedService(
      LifecycleScope.Agent,
      IAgentPermissionPolicyService,
      RuleBasedPermissionPolicy,
    );
    // `IAgentPermissionGate` is NOT registered here: its constructor takes a
    // leading `options` value before its @IX dependencies, so it is seeded as a
    // SyncDescriptor (carrying `[{}]`) on the Agent scope in `buildAgent()`.
  });

  function buildAgent() {
    const host = createScopedTestHost([
      stubPair(ITelemetryService, noopTelemetryService),
    ]);
    const session = host.child(LifecycleScope.Session, 's1', [
      stubPair(ISessionContext, fakeSession),
    ]);
    const agent = host.childOf(session, LifecycleScope.Agent, 'main', [
      // The real gate expects a leading `PermissionGateOptions` argument
      // (before its @IX dependencies), so it is provided as a SyncDescriptor
      // with `[{}]` — the same shape the production composition root uses.
      [IAgentPermissionGate, new SyncDescriptor(AgentPermissionGate, [{}])],
      stubPair(IAgentRecordService, fakeRecord),
      stubPair(IAgentContextInjectorService, fakeContextInjector),
      stubPair(IAgentToolExecutorService, fakeToolExecutor),
      stubPair(IAgentExternalHooksService, fakeExternalHooks),
    ]);
    return { host, agent };
  }

  it('denies a tool when a matching deny rule is registered', async () => {
    const { host, agent } = buildAgent();
    agent.accessor
      .get(IAgentPermissionRulesService)
      .addRules([{ decision: 'deny', scope: 'user', pattern: 'Bash' }]);

    const result = await agent.accessor
      .get(IAgentPermissionGate)
      .authorize(toolContext('Bash'));

    expect(result?.block).toBe(true);
    expect(result?.reason).toContain('Bash');

    host.dispose();
  });

  it('flips the decision on the same agent when a rule changes', async () => {
    const { host, agent } = buildAgent();
    const gate = agent.accessor.get(IAgentPermissionGate);
    const rules = agent.accessor.get(IAgentPermissionRulesService);

    // No rules + manual mode => the chain returns no decision, so the gate
    // allows the call (undefined verdict).
    expect(await gate.authorize(toolContext('Bash'))).toBeUndefined();

    // Adding a deny rule flips the same tool from allowed to blocked.
    rules.addRules([{ decision: 'deny', scope: 'user', pattern: 'Bash' }]);

    const denied = await gate.authorize(toolContext('Bash'));
    expect(denied?.block).toBe(true);

    host.dispose();
  });

  it('surfaces the composed mode + rules through gate.data()', () => {
    const { host, agent } = buildAgent();
    agent.accessor.get(IAgentPermissionModeService).setMode('yolo');
    agent.accessor
      .get(IAgentPermissionRulesService)
      .addRules([{ decision: 'allow', scope: 'user', pattern: 'Read' }]);

    expect(agent.accessor.get(IAgentPermissionGate).data()).toEqual({
      mode: 'yolo',
      rules: [{ decision: 'allow', scope: 'user', pattern: 'Read' }],
    });

    host.dispose();
  });

  it('lets yolo mode approve, but a deny rule still blocks', async () => {
    const { host, agent } = buildAgent();
    const gate = agent.accessor.get(IAgentPermissionGate);
    agent.accessor.get(IAgentPermissionModeService).setMode('yolo');

    // yolo approves a tool with no matching rule.
    expect(await gate.authorize(toolContext('Read'))).toBeUndefined();

    // A deny rule fires regardless of mode.
    agent.accessor
      .get(IAgentPermissionRulesService)
      .addRules([{ decision: 'deny', scope: 'user', pattern: 'Read' }]);

    expect((await gate.authorize(toolContext('Read')))?.block).toBe(true);

    host.dispose();
  });
});
