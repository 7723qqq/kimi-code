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
import { IAgentSpecService, SPEC_DIR_NAME, SPEC_REQUIRED_FILES } from '#/features/spec/spec';
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
  let existing: Set<string>;
  let resolveLinks: Map<string, string | null>;
  let readText: Mock<(path: string) => Promise<string>>;
  let removed: string[];
  let mkdir: Mock<(path: string, options?: { recursive?: boolean }) => Promise<void>>;
  let setContext: Mock<(patch: { mode?: string }) => void>;

  beforeEach(() => {
    disposables = new DisposableStore();
    records = [];
    requests = [];
    approvalResponse = { decision: 'approved' };
    formatDenyMessage = vi.fn((message: string) => message);
    mode = 'manual';
    files = new Map();
    existing = new Set([WORK_DIR, `${WORK_DIR}/${SPEC_DIR_NAME}`]);
    resolveLinks = new Map();
    readText = vi.fn(async (path: string) => files.get(path) ?? '');
    removed = [];
    mkdir = vi.fn().mockResolvedValue(undefined);
    setContext = vi.fn();
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
            mkdir,
            readText,
            remove: vi.fn(async (path: string) => {
              removed.push(path);
              files.delete(path);
              existing.delete(path);
            }),
            writeText: vi.fn(async (path: string, content: string) => {
              files.set(path, content);
            }),
            realpath: vi.fn(async (path: string) => {
              const target = resolveLinks.get(path);
              if (target !== undefined) {
                if (target === null) throw new Error(`ENOENT: ${path}`);
                return target;
              }
              if (!existing.has(path)) throw new Error(`ENOENT: ${path}`);
              return path;
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
        reg.defineInstance(
          ITelemetryService,
          { ...recordingTelemetry(records), setContext },
        );
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
    existing.add(SPEC_DIR);
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

  it('allows writing a document that does not exist yet', async () => {
    await enterSpec();
    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(`${SPEC_DIR}/tasks.md`) }),
    );
    expect(decision).toBeUndefined();
  });

  it('rejects a write through a symlink pointing outside the spec directory', async () => {
    await enterSpec();
    const link = `${SPEC_DIR}/notes.md`;
    resolveLinks.set(link, `${WORK_DIR}/src/notes.md`);
    existing.add(`${WORK_DIR}/src/notes.md`);

    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(link) }),
    );
    expect(decision?.veto?.isError).toBe(true);
    expect(decision?.veto?.output).toContain('spec directory');
  });

  it('allows a write through a symlink that stays inside the spec directory', async () => {
    await enterSpec();
    const link = `${SPEC_DIR}/alias.md`;
    resolveLinks.set(link, `${SPEC_DIR}/tasks.md`);

    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(link) }),
    );
    expect(decision).toBeUndefined();
  });

  it('rejects a write when the spec directory itself cannot be resolved', async () => {
    await enterSpec();
    resolveLinks.set(SPEC_DIR, null);

    const decision = await run(
      hookContext('Write', { accesses: ToolAccesses.writeFile(`${SPEC_DIR}/tasks.md`) }),
    );
    expect(decision?.veto?.isError).toBe(true);
  });

  it('rejects an access kind the guard cannot inspect', async () => {
    await enterSpec();
    const decision = await run(hookContext('Team', { accesses: ToolAccesses.all() }));
    expect(decision?.veto?.isError).toBe(true);
    expect(decision?.veto?.output).toContain('spec directory');
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

  it('leaves no spec state behind when the directory cannot be created', async () => {
    mkdir.mockRejectedValueOnce(new Error('EACCES: permission denied'));

    await expect(spec().enter(SPEC_ID)).rejects.toThrow(/permission denied/);

    expect(await spec().status()).toBeNull();
  });

  it('rolls back the entered state when telemetry context cannot be set', async () => {
    setContext.mockImplementation(() => {
      throw new Error('telemetry unavailable');
    });

    await expect(spec().enter(SPEC_ID)).rejects.toThrow(/telemetry unavailable/);

    expect(await spec().status()).toBeNull();
  });

  it('sets the spec telemetry context on a successful enter', async () => {
    await enterSpec();

    // Spec is its own mode: reporting it as `plan` made the two
    // indistinguishable to anything reading the telemetry context.
    expect(setContext).toHaveBeenCalledWith({ mode: 'spec' });
    expect(await spec().status()).not.toBeNull();
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

  it('clears the documents when clear() is called', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '# Requirements');
    files.set(`${SPEC_DIR}/design.md`, '# Design');
    files.set(`${SPEC_DIR}/tasks.md`, '# Tasks');
    removed = [];

    await spec().clear();

    for (const name of SPEC_REQUIRED_FILES) {
      files.delete(`${SPEC_DIR}/${name}`);
    }

    const status = await spec().status();
    expect(status?.complete).toBe(false);
    expect(status?.missing).toEqual([...SPEC_REQUIRED_FILES]);
    expect(removed).toContain(`${SPEC_DIR}/requirements.md`);
  });

  it('removes the progress file too, and tolerates one that was never written', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/tasks.md`, '# Tasks');
    removed = [];

    await spec().clear();

    expect(removed).toContain(`${SPEC_DIR}/progress.md`);
    expect(removed).toContain(`${SPEC_DIR}/tasks.md`);
  });

  it('leaves the spec directory itself in place after clear()', async () => {
    await enterSpec();
    removed = [];

    await spec().clear();

    expect(removed).not.toContain(SPEC_DIR);
    expect(await spec().status()).not.toBeNull();
  });

  it('does not touch the filesystem when no spec is active', async () => {
    removed = [];

    await spec().clear();

    expect(removed).toEqual([]);
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

  it('reads each required document exactly once per status call', async () => {
    await enterSpec();
    readText.mockClear();

    await spec().status();

    const specReads = readText.mock.calls.filter(([path]: [string]) =>
      SPEC_REQUIRED_FILES.some((name) => path.endsWith(`/${name}`)),
    );
    expect(specReads).toHaveLength(SPEC_REQUIRED_FILES.length);
  });

  it('reads each required document once when recording a revision from status', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '# Requirements');
    files.set(`${SPEC_DIR}/design.md`, '# Design');
    files.set(`${SPEC_DIR}/tasks.md`, '# Tasks');
    readText.mockClear();

    const data = await spec().status();
    if (data === null) throw new Error('expected an active spec');
    await spec().recordRevision(data);

    const specReads = readText.mock.calls.filter(([path]: [string]) =>
      SPEC_REQUIRED_FILES.some((name) => path.endsWith(`/${name}`)),
    );
    expect(specReads).toHaveLength(SPEC_REQUIRED_FILES.length);
  });

  it('reads the progress file as part of the same status call', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/progress.md`, '# Progress\n\n- did a thing');
    readText.mockClear();

    const status = await spec().status();

    expect(status?.progress).toContain('did a thing');
    expect(readText).toHaveBeenCalledTimes(SPEC_REQUIRED_FILES.length + 1);
  });

  it('reports an empty progress file without treating it as missing', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '# Requirements');
    files.set(`${SPEC_DIR}/design.md`, '# Design');
    files.set(`${SPEC_DIR}/tasks.md`, '# Tasks');
    files.set(`${SPEC_DIR}/progress.md`, '   \n  ');

    const status = await spec().status();

    expect(status?.progress.trim()).toBe('');
    expect(status?.complete).toBe(true);
    expect(status?.missing).toEqual([]);
  });

  it('stays complete when the progress file was never written', async () => {
    await enterSpec();
    files.set(`${SPEC_DIR}/requirements.md`, '# Requirements');
    files.set(`${SPEC_DIR}/design.md`, '# Design');
    files.set(`${SPEC_DIR}/tasks.md`, '# Tasks');

    const status = await spec().status();

    expect(status?.progress).toBe('');
    expect(status?.complete).toBe(true);
  });
});
