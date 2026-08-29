import { PassThrough, Readable, type Writable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentTaskService } from '#/agent/task/task';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { type BashInput } from '#/agent/tools/os/bash/bash';
import { BashTool } from '#/agent/tools/os/bash/bashTool';
import { NativeBashProcess } from '#/agent/tools/os/bash/native-bash-process';
import type { IConfigService } from '#/app/config/config';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import type {
  ExecutableToolContext,
  ExecutableToolResult,
  ToolExecution,
} from '#/tool/toolContract';

import { stubWorkspaceContext } from '../../../../session/workspaceContext/stub-workspace-context';

const mocks = vi.hoisted(() => ({
  tryNativeBashSpawn: vi.fn(),
  tryNativeBashWait: vi.fn(),
  tryNativeBashKill: vi.fn(),
  tryNativeBashDispose: vi.fn(),
}));

vi.mock('#/_base/native-tools', () => mocks);

const posixEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Linux',
  osArch: 'arm64',
  osVersion: 'test',
  shellPath: '/bin/bash',
  shellName: 'bash',
  pathClass: 'posix',
  homeDir: '/home/test',
  ready: Promise.resolve(),
};

/** A fake native bash handle that forwards events like the real addon. */
function fakeNativeHandle(id: number, pid: number) {
  let eventCallback: ((event: unknown) => void) | undefined;
  const handle = {
    id,
    pid,
    setCallback(cb: (event: unknown) => void) {
      eventCallback = cb;
    },
    emit(event: unknown) {
      eventCallback?.(event);
    },
  };
  mocks.tryNativeBashSpawn.mockImplementation((_config, onEvent) => {
    handle.setCallback(onEvent);
    return { id, pid };
  });
  mocks.tryNativeBashWait.mockResolvedValue({ exitCode: 0, timedOut: false });
  mocks.tryNativeBashKill.mockReturnValue(true);
  mocks.tryNativeBashDispose.mockReturnValue(true);
  return handle;
}

function stubToolPolicy(): IAgentToolPolicyService {
  return {
    _serviceBrand: undefined,
    isToolActive: () => true,
  } as unknown as IAgentToolPolicyService;
}

function stubConfig(): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as IConfigService;
}

function createFakeTaskService() {
  const tasks = new Map<string, { task: unknown; options: unknown }>();
  return {
    service: {
      registerTask: vi.fn((task, options) => {
        const taskId = `bash-${tasks.size + 1}`;
        tasks.set(taskId, { task, options });
        return taskId;
      }),
      waitForForegroundRelease: vi.fn(() => Promise.resolve('completed')),
      getTask: vi.fn(() => undefined),
      persistOutput: vi.fn(),
      stopAllOnExit: vi.fn(),
    } as unknown as IAgentTaskService,
    tasks,
  };
}

function bashTool(
  runner: IHostProcessService,
  env: IHostEnvironment = posixEnv,
  ctx: ISessionContext = makeTestCtx(),
  background: IAgentTaskService = createFakeTaskService().service,
): BashTool {
  const processService: IHostProcessService = {
    _serviceBrand: undefined,
    spawn: async (...args) => runner.spawn(...(args as Parameters<IHostProcessService['spawn']>)),
  };
  const backend = Object.assign(
    new FakeRuntime(
      { workspaceId: ctx.workspaceId, runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: env.pathClass },
    ),
    { environment: env, process: processService },
  );
  const runtime = {
    _serviceBrand: undefined,
    onDidChange: () => ({ dispose: () => {} }),
    isAvailable: () => true,
    inspect: () => backend,
    acquire: () => ({
      runtime: backend,
      track: (resource: unknown) => resource,
      dispose: () => {},
    }),
  } as unknown as IAgentRuntimeService;
  return new BashTool(
    runtime,
    ctx,
    stubWorkspaceContext(ctx.cwd),
    background,
    stubToolPolicy(),
    stubConfig(),
  );
}

function makeTestCtx(): ISessionContext {
  return {
    _serviceBrand: undefined,
    cwd: '/workspace',
    workspaceId: 'ws-test',
  } as unknown as ISessionContext;
}

function context(
  args: BashInput,
  signal = new AbortController().signal,
  onForegroundTaskStart?: (taskId: string) => void,
) {
  return { turnId: 0, toolCallId: 'call_bash', args, signal, onForegroundTaskStart };
}

function isPromiseLike(
  value: ToolExecution | Promise<ToolExecution>,
): value is Promise<ToolExecution> {
  return typeof (value as Promise<ToolExecution>).then === 'function';
}

async function executeTool(
  tool: BashTool,
  ctx: ReturnType<typeof context>,
): Promise<ExecutableToolResult> {
  const { args, ...executionContext } = ctx;
  const resolved = tool.resolveExecution(args);
  const execution = isPromiseLike(resolved) ? await resolved : resolved;
  if (execution.isError === true) return execution;
  return execution.execute(executionContext as ExecutableToolContext);
}

describe('NativeBashProcess', () => {
  beforeEach(() => {
    mocks.tryNativeBashWait.mockReset();
    mocks.tryNativeBashKill.mockReset();
    mocks.tryNativeBashDispose.mockReset();
    mocks.tryNativeBashWait.mockResolvedValue(undefined);
  });

  it('streams stdout/stderr events and resolves wait on the exit event', async () => {
    const proc = new NativeBashProcess(7, 4242);
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    proc.stdout.on('data', (chunk) => stdoutChunks.push(String(chunk)));
    proc.stderr.on('data', (chunk) => stderrChunks.push(String(chunk)));

    proc.handleEvent({ id: 7, kind: 'stdout', data: 'out1' });
    proc.handleEvent({ id: 7, kind: 'stderr', data: 'err1' });
    const waitPromise = proc.wait();
    proc.handleEvent({ id: 7, kind: 'exit', exitCode: 3 });

    await expect(waitPromise).resolves.toBe(3);
    expect(proc.exitCode).toBe(3);
    expect(stdoutChunks).toEqual(['out1']);
    expect(stderrChunks).toEqual(['err1']);
    await proc.dispose();
    expect(mocks.tryNativeBashDispose).toHaveBeenCalledWith(7);
  });

  it('settles wait from the native exit cache when no exit event arrives', async () => {
    mocks.tryNativeBashWait.mockResolvedValue({ exitCode: 5, timedOut: false });
    const proc = new NativeBashProcess(9, 4242);

    await expect(proc.wait()).resolves.toBe(5);
    expect(proc.exitCode).toBe(5);
    await proc.dispose();
  });

  it('forwards kill to the native engine and ignores the signal argument', async () => {
    mocks.tryNativeBashKill.mockReturnValue(true);
    const proc = new NativeBashProcess(11, 4242);
    await proc.kill('SIGTERM');
    expect(mocks.tryNativeBashKill).toHaveBeenCalledWith(11);
    await proc.dispose();
  });
});

describe('BashTool native fast path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.tryNativeBashSpawn.mockReset();
    mocks.tryNativeBashWait.mockReset();
    mocks.tryNativeBashKill.mockReset();
    mocks.tryNativeBashDispose.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('spawns via the native engine instead of the host runner', async () => {
    fakeNativeHandle(7, 4242);
    const hostRunner = { spawn: vi.fn() } as unknown as IHostProcessService;
    const tool = bashTool(hostRunner);

    void executeTool(tool, context({ command: 'printf hi', timeout: 60 }));

    expect(mocks.tryNativeBashSpawn).toHaveBeenCalledTimes(1);
    expect(hostRunner.spawn).not.toHaveBeenCalled();
  });

  it('falls back to the host spawn when the native spawn is unavailable', async () => {
    mocks.tryNativeBashSpawn.mockReturnValue(undefined);
    const fakeProc: IHostProcess = {
      _serviceBrand: undefined,
      stdin: { end: vi.fn(), write: vi.fn() } as unknown as Writable,
      stdout: Readable.from(['fallback\n']),
      stderr: Readable.from([]),
      pid: 1,
      exitCode: 0,
      wait: async () => 0,
      kill: async () => {},
      dispose: async () => {},
    };
    const hostRunner = { spawn: vi.fn().mockResolvedValue(fakeProc) } as unknown as IHostProcessService;
    const tool = bashTool(hostRunner);

    void executeTool(tool, context({ command: 'echo fallback', timeout: 60 }));

    expect(mocks.tryNativeBashSpawn).toHaveBeenCalledTimes(1);
    expect(hostRunner.spawn).toHaveBeenCalledTimes(1);
  });

  it('does not pass a native timeout so the host owns backgrounding decisions', async () => {
    const handle = fakeNativeHandle(8, 4243);
    const hostRunner = { spawn: vi.fn() } as unknown as IHostProcessService;
    const tool = bashTool(hostRunner);

    void executeTool(tool, context({ command: 'sleep 1', timeout: 60 }));

    const [config] = mocks.tryNativeBashSpawn.mock.calls[0]! as [unknown, unknown];
    expect(config).toMatchObject({
      argv: ['/bin/bash', '-c', "cd '/workspace' && sleep 1"],
      cwd: '/workspace',
    });
    expect(config).not.toHaveProperty('timeoutMs');
  });
});
