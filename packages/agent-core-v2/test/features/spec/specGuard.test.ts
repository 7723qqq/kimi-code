import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  ApprovalResponse,
  PermissionMode,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { IAgentSpecService, SPEC_DIR_NAME } from '#/features/spec/spec';
import { AgentSpecService } from '#/features/spec/specService';
import type { ToolCall } from '#human/llm/message';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { IBlobStore } from '#/persistence/interface/blobStore';
import { BlobStoreService } from '#/persistence/backends/node-fs/blobStoreService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { ToolAccesses } from '#/tool/toolContract';

import { stubPermissionModeService } from '../../agent/permissionMode/stubs';
import {
  stubToolExecutorEvents,
  type ToolExecutorEventStubs,
} from '../../agent/toolExecutor/stubs';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';
import { createReminderStub } from '../reminder/stubs';
import { createFakeHostFs } from '../../tools/fixtures/fake-exec';
import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';
import { registerTestAgentWireServices } from '../../wire/stubs';

const signal = new AbortController().signal;
const WORK_DIR = '/ws';
const SPEC_ID = 'spec-1';
const SPEC_DIR = `${WORK_DIR}/${SPEC_DIR_NAME}/${SPEC_ID}`;

type AskResult = Extract<PermissionPolicyResult, { kind: 'ask' }>;

interface ApprovalRequestRecord {
  readonly ask: AskResult;
  readonly origin: string;
}

function toolCall(name: string, args: Record<string, unknown>): ToolCall {
  return {
    type: 'function',
    id: `call_${name.toLowerCase()}`,
    name,
    arguments: JSON.stringify(args),
  };
}

function hookContext(
  toolName: string,
  input: {
    readonly args?: Record<string, unknown>;
    readonly accesses?: ToolAccesses;
  } = {},
): ResolvedToolExecutionHookContext {
  const args = input.args ?? {};
  const call = toolCall(toolName, args);
  return {
    turnId: 0,
    signal,
    toolCall: call,
    toolCalls: [call],
    args,
    execution: {
      accesses: input.accesses,
      approvalRule: toolName,
      execute: async () => ({ output: '' }),
    },
  };
}

function mapResolution(
  resolution: PermissionPolicyResolution | undefined,
): BeforeExecuteDecision | undefined {
  if (resolution === undefined) return undefined;
  if (resolution.kind !== 'result') {
    throw new Error('the review stub only resolves synthetic results');
  }
  return { veto: resolution.result };
}

describe('AgentSpecService write guard', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let records: TelemetryRecord[];
  let requests: ApprovalRequestRecord[];
  let approvalResponse: ApprovalResponse;
  let formatDenyMessage: Mock<(message: string) => string>;
  let mode: PermissionMode;
  let files: Map<string, string>;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    requests = [];
    approvalResponse = { decision: 'approved' };
    formatDenyMessage = vi.fn((message: string) => message);
    mode = 'manual';
    files = new Map();
    executorEvents = stubToolExecutorEvents();

    const toolApproval: IAgentToolApprovalService = {
      _serviceBrand: undefined,
      resolvePermissionResolution: async () => {
        throw new Error('resolvePermissionResolution is not used by the spec guard');
      },
      requestToolApproval: async (_context, ask, origin) => {
        requests.push({ ask, origin });
        return mapResolution(ask.resolveApproval?.(approvalResponse));
      },
      formatDenyMessage: (message: string) => formatDenyMessage(message),
      formatApprovalRejectionMessage: (toolName, result) =>
        `Tool "${toolName}" was not run (${result.decision}).`,
    };

    ix = createServices(disposables, {
      additionalServices: (reg) => {
        registerTestAgentWireServices(reg);
        reg.defineInstance(
          IHostFileSystem,
          createFakeHostFs({
            mkdir: vi.fn().mockResolvedValue(undefined),
            readText: vi.fn(async (path: string) => files.get(path) ?? ''),
            writeText: vi.fn(async (path: string, content: string) => {
              files.set(path, content);
            }),
          }),
        );
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspaceContext(WORK_DIR));
        reg.defineInstance(IBlobStore, new BlobStoreService(new InMemoryStorageService()));
        reg.definePartialInstance(IAgentContextMemoryService, {});
        reg.defineInstance(IAgentReminderService, createReminderStub());
        reg.defineInstance(IAgentToolExecutorService, executorEvents.executor);
        reg.defineInstance(IAgentToolApprovalService, toolApproval);
        reg.defineInstance(
          IAgentPermissionModeService,
          stubPermissionModeService(() => mode),
        );
        reg.defineInstance(ITelemetryService, recordingTelemetry(records));
        reg.defineInstance(IAgentStateService, new AgentStateService());
        reg.define(IAgentSpecService, AgentSpecService);
      },
    });
  });

  afterEach(() => disposables.dispose());

  function spec(): IAgentSpecService {
    return ix.get(IAgentSpecService);
  }

  async function enterSpec(): Promise<IAgentSpecService> {
    const svc = spec();
    await svc.enter(SPEC_ID);
    return svc;
  }

  async function run(
    ctx: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    return executorEvents.fireBeforeExecute(ctx);
  }

  it('allows a write inside the spec directory', async () => {
    await enterSpec();
    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(`${SPEC_DIR}/design.md`) }),
    );
    expect(decision).toBeUndefined();
  });

  it('rejects a write outside the spec directory', async () => {
    await enterSpec();
    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(`${WORK_DIR}/src/x.ts`) }),
    );
    expect(decision?.veto?.isError).toBe(true);
    expect(decision?.veto?.output).toContain('spec directory');
    expect(decision?.veto?.output).toContain('ExitSpecMode');
  });

  it('rejects a path that escapes the spec directory', async () => {
    await enterSpec();
    const decision = await run(
      hookContext('Write', {
        accesses: ToolAccesses.writeFile(`${SPEC_DIR}/../src/x.ts`),
      }),
    );
    expect(decision?.veto?.isError).toBe(true);
  });

  it('rejects a write when one of several accesses lands outside', async () => {
    await enterSpec();
    const decision = await run(
      hookContext('Edit', {
        accesses: [
          ...ToolAccesses.writeFile(`${SPEC_DIR}/design.md`),
          ...ToolAccesses.writeFile(`${WORK_DIR}/src/x.ts`),
        ],
      }),
    );
    expect(decision?.veto?.isError).toBe(true);
  });

  it('leaves read-only tools untouched', async () => {
    await enterSpec();
    const decision = await run(hookContext('Read', { accesses: ToolAccesses.readFile('/etc/x') }));
    expect(decision).toBeUndefined();
  });

  it('rejects TaskStop while spec mode is active', async () => {
    await enterSpec();
    const decision = await run(hookContext('TaskStop'));
    expect(decision?.veto?.isError).toBe(true);
  });

  it('allows writes again once spec mode has exited', async () => {
    const svc = await enterSpec();
    svc.exit();
    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(`${WORK_DIR}/src/x.ts`) }),
    );
    expect(decision).toBeUndefined();
  });

  it('refuses to enter twice', async () => {
    const svc = await enterSpec();
    await expect(svc.enter('spec-2')).rejects.toThrow(/already in spec mode/i);
  });

  it('reports the missing documents while the spec is incomplete', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '# Requirements');

    const status = await spec().status();
    expect(status?.complete).toBe(false);
    expect(status?.missing).toContain('design.md');
    expect(status?.missing).toContain('tasks.md');
    expect(status?.missing).not.toContain('requirements.md');
  });

  it('treats a whitespace-only document as missing', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '   \n  ');

    const status = await spec().status();
    expect(status?.missing).toContain('requirements.md');
  });

  it('reports the spec complete once all three documents have content', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '# Requirements');
    files.set(`${SPEC_DIR}/design.md`, '# Design');
    files.set(`${SPEC_DIR}/tasks.md`, '# Tasks');

    const status = await spec().status();
    expect(status?.complete).toBe(true);
    expect(status?.missing).toEqual([]);
  });
});
