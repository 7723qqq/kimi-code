import { describe, expect, it, mock } from 'bun:test';
import { Readable, type Writable } from 'node:stream';

import { shellPayloadExePath, shellPayloadPinOf } from '#/_base/execEnv/shellPayload';
import type { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import type { IAgentTaskService, RegisterAgentTaskOptions } from '#/agent/task/task';
import type { AgentTask, AgentTaskInfo, AgentTaskSettlement } from '#/agent/task/types';
import type { IAgentToolPolicyService } from '#/agent/toolPolicy/toolPolicy';
import { getAgentToolContributions } from '#/agent/toolRegistry/toolContribution';
import {
  type PowerShellExecutable,
  type PowerShellInput,
  type PowerShellResolveDeps,
  PowerShellInputSchema,
  buildPowerShellArgs,
  normalizePowerShellOutput,
  resolvePowerShellExecutable,
} from '#/agent/tools/os/powershell/powershell';
import { PowerShellTool } from '#/agent/tools/os/powershell/powershellTool';
import type { IConfigService } from '#/app/config/config';
import type { IHostEnvironment } from '#/os/interface/hostEnvironment';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { FakeRuntime } from '#/runtime/fakeRuntime';
import { type ISessionContext, makeSessionContext } from '#/session/sessionContext/sessionContext';
import type { ExecutableToolResult, ExecutableToolContext } from '#/tool/toolContract';
import { stubWorkspaceContext } from '#test/session/workspaceContext/stub-workspace-context';

function decodePowerShellArgs(args: readonly string[]): string {
  const encoded = args[args.length - 1];
  if (args[args.length - 2] !== '-EncodedCommand' || encoded === undefined) {
    throw new Error('PowerShell args do not carry an -EncodedCommand payload');
  }
  return Buffer.from(encoded, 'base64').toString('utf16le');
}

const windowsEnv: IHostEnvironment = {
  _serviceBrand: undefined,
  osKind: 'Windows',
  osArch: 'x64',
  osVersion: 'test',
  shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
  shellName: 'bash',
  pathClass: 'win32',
  homeDir: 'C:\\Users\\test',
  ready: Promise.resolve(),
};

function processWithOutput(options: {
  readonly stdout?: string;
  readonly exitCode?: number;
}): IHostProcess {
  const exitCode = options.exitCode ?? 0;
  const stdout = Readable.from(options.stdout === undefined ? [] : [options.stdout]);
  const stderr = Readable.from([]);
  return {
    _serviceBrand: undefined,
    stdin: { end: mock(), write: mock() } as unknown as Writable,
    stdout,
    stderr,
    pid: 123,
    exitCode,
    wait: mock(async () => exitCode),
    kill: mock(async () => {}),
    dispose: mock(async () => {
      stdout.destroy();
      stderr.destroy();
    }),
  };
}

function createMiniTaskService(): IAgentTaskService {
  interface Entry {
    readonly task: AgentTask;
    info?: AgentTaskInfo;
    settled: boolean;
    waiters: Array<() => void>;
  }
  const entries = new Map<string, Entry>();
  let seq = 0;
  const service = {
    registerTask(task: AgentTask, options: RegisterAgentTaskOptions): string {
      const taskId = `ps_${String(++seq)}`;
      const entry: Entry = { task, settled: false, waiters: [] };
      entries.set(taskId, entry);
      void task.start({
        signal: options.signal ?? new AbortController().signal,
        appendOutput: () => {},
        settle: async (settlement: AgentTaskSettlement): Promise<boolean> => {
          entry.settled = true;
          entry.info = {
            ...task.toInfo({
              taskId,
              description: '',
              status: settlement.status,
              startedAt: 0,
              endedAt: 1,
            }),
            stopReason: settlement.stopReason,
          };
          for (const wake of entry.waiters.splice(0)) wake();
          return true;
        },
      });
      return taskId;
    },
    getTask: (taskId: string) => entries.get(taskId)?.info,
    persistOutput: () => {},
    getOutputSnapshot: async () => ({
      fullOutputAvailable: false,
      outputSizeBytes: 0,
    }),
    waitForForegroundRelease: async (taskId: string) => {
      const entry = entries.get(taskId);
      if (entry === undefined) return undefined;
      if (!entry.settled) await new Promise<void>((resolve) => entry.waiters.push(resolve));
      return 'terminal' as const;
    },
  };
  return service as unknown as IAgentTaskService;
}

function createTestCtx(cwd = 'C:\\workspace'): ISessionContext {
  return makeSessionContext({
    sessionId: 's',
    workspaceId: 'w',
    sessionDir: cwd,
    sessionScope: 'sessions/w/s',
    cwd,
  });
}

function powerShellTool(
  spawn: IHostProcessService['spawn'],
  resolveExecutable: (deps: PowerShellResolveDeps) => Promise<PowerShellExecutable>,
): PowerShellTool {
  const processService: IHostProcessService = {
    _serviceBrand: undefined,
    spawn,
  } as unknown as IHostProcessService;
  const ctx = createTestCtx();
  const backend = Object.assign(
    new FakeRuntime(
      { workspaceId: ctx.workspaceId, runtimeId: 'local', generation: 'test' },
      { capabilities: ['process'], pathClass: 'win32' },
    ),
    { environment: windowsEnv, process: processService },
  );
  const runtime: IAgentRuntimeService = {
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
  const toolPolicy = {
    _serviceBrand: undefined,
    isToolActive: () => true,
  } as unknown as IAgentToolPolicyService;
  const config = {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as IConfigService;
  return new PowerShellTool(
    runtime,
    ctx,
    stubWorkspaceContext(ctx.cwd),
    createMiniTaskService(),
    toolPolicy,
    config,
    { resolveExecutable },
  );
}

async function executeTool(
  tool: PowerShellTool,
  args: PowerShellInput,
): Promise<ExecutableToolResult> {
  const execution = await tool.resolveExecution(args);
  if (execution.isError === true) return execution;
  return execution.execute({
    turnId: 0,
    toolCallId: 'call_ps',
    args,
    signal: new AbortController().signal,
  } as ExecutableToolContext);
}

describe('PowerShellInputSchema', () => {
  it('accepts scripts and enforces timeout caps', () => {
    expect(PowerShellInputSchema.safeParse({ command: 'Get-Date' }).success).toBe(true);
    expect(PowerShellInputSchema.safeParse({ command: '' }).success).toBe(false);
    expect(PowerShellInputSchema.safeParse({ command: 'x', timeout: 0 }).success).toBe(false);
    expect(PowerShellInputSchema.safeParse({ command: 'x', timeout: 301 }).success).toBe(false);
    expect(PowerShellInputSchema.safeParse({ command: 'x', timeout: 300 }).success).toBe(true);
    expect(
      PowerShellInputSchema.safeParse({
        command: 'x',
        run_in_background: true,
        description: 'job',
        timeout: 86_400,
      }).success,
    ).toBe(true);
    expect(
      PowerShellInputSchema.safeParse({
        command: 'x',
        run_in_background: true,
        description: 'job',
        timeout: 86_401,
      }).success,
    ).toBe(false);
  });
});

describe('PowerShell arg assembly', () => {
  it('wraps the script in -EncodedCommand with the UTF-8 preamble', () => {
    const args = buildPowerShellArgs("Write-Output '中文测试ABC'");
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    const decoded = decodePowerShellArgs(args);
    expect(decoded).toContain('[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new()');
    expect(decoded).toContain("$ProgressPreference='SilentlyContinue'");
    expect(decoded).toContain("Write-Output '中文测试ABC'");
  });

  it('round-trips arbitrary script text through the encoded payload', () => {
    const script = 'Get-ChildItem -Path "C:\\路径 with spaces" | Select-Object Name';
    expect(decodePowerShellArgs(buildPowerShellArgs(script))).toContain(script);
  });

  it('normalizes CRLF to LF in output', () => {
    expect(normalizePowerShellOutput('a\r\nb\r\nc')).toBe('a\nb\nc');
    expect(normalizePowerShellOutput('no-eol')).toBe('no-eol');
  });
});

describe('resolvePowerShellExecutable', () => {
  const stub = (
    env: Record<string, string | undefined>,
    existing: readonly string[],
  ): PowerShellResolveDeps => ({
    env,
    osHomeDir: 'C:\\Users\\me',
    isFile: async (path: string) => existing.includes(path),
  });

  it('prefers KIMI_PWSH_PATH', async () => {
    const exe = await resolvePowerShellExecutable(
      stub({ KIMI_PWSH_PATH: 'D:\\custom\\pwsh.exe' }, ['D:\\custom\\pwsh.exe']),
    );
    expect(exe).toEqual({ path: 'D:\\custom\\pwsh.exe', kind: 'pwsh' });
  });

  it('finds pwsh on PATH before the standard install', async () => {
    const onPath = 'C:\\tools\\pwsh.exe';
    const exe = await resolvePowerShellExecutable(
      stub({ PATH: 'C:\\tools' }, [onPath, 'C:\\Program Files\\PowerShell\\7\\pwsh.exe']),
    );
    expect(exe).toEqual({ path: onPath, kind: 'pwsh' });
  });

  it('uses the provisioned pwsh payload when no system pwsh exists', async () => {
    const payloadExe = shellPayloadExePath('D:\\kimi-home', shellPayloadPinOf('pwsh'));
    const exe = await resolvePowerShellExecutable(
      stub({ PATH: 'C:\\nope', KIMI_CODE_HOME: 'D:\\kimi-home' }, [payloadExe]),
    );
    expect(exe.kind).toBe('pwsh');
    expect(exe.path).toContain('shells');
    expect(exe.path).toBe(payloadExe);
  });

  it('prefers the provisioned pwsh payload over system pwsh', async () => {
    const payloadExe = shellPayloadExePath('D:\\kimi-home', shellPayloadPinOf('pwsh'));
    const exe = await resolvePowerShellExecutable(
      stub({ PATH: 'C:\\tools', KIMI_CODE_HOME: 'D:\\kimi-home' }, [
        'C:\\tools\\pwsh.exe',
        payloadExe,
      ]),
    );
    expect(exe).toEqual({ path: payloadExe, kind: 'pwsh' });
  });

  it('falls back to system pwsh when the payload is absent', async () => {
    const onPath = 'C:\\tools\\pwsh.exe';
    const exe = await resolvePowerShellExecutable(stub({ PATH: 'C:\\tools' }, [onPath]));
    expect(exe).toEqual({ path: onPath, kind: 'pwsh' });
  });

  it('falls back to Windows PowerShell 5.1', async () => {
    const exe = await resolvePowerShellExecutable(
      stub({ PATH: 'C:\\nope', SystemRoot: 'D:\\Windows' }, [
        'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ]),
    );
    expect(exe.kind).toBe('windows-powershell');
  });

  it('throws with provisioning guidance when nothing is found', async () => {
    const rejected: unknown = await resolvePowerShellExecutable(stub({ PATH: '' }, [])).catch(
      (error: unknown) => error,
    );
    expect((rejected as Error).message).toContain('kimi shells provision --pwsh');
  });
});

describe('PowerShellTool', () => {
  it('registers as a Windows-only tool', () => {
    const contribution = getAgentToolContributions().find(
      (entry) => entry.options.name === 'PowerShell',
    );
    expect(contribution).toBeDefined();
    expect(contribution?.options.requiredRuntimeCapabilities).toEqual(['process']);
    expect(contribution?.options.when?.({} as never)).toBe(process.platform === 'win32');
  });

  it('exposes schema and resolves execution with an approval rule', () => {
    const tool = powerShellTool(mock().mockResolvedValue(processWithOutput({})), async () => ({
      path: 'C:\\pwsh.exe',
      kind: 'pwsh',
    }));
    expect(tool.name).toBe('PowerShell');
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: { command: { type: 'string' } },
    });
    const execution = tool.resolveExecution({ command: 'Get-Date' });
    if (execution.isError === true) throw new Error('unexpected error result');
    expect(execution.display?.kind).toBe('command');
    expect(execution.approvalRule).toBeDefined();
  });

  it('spawns the resolved executable with encoded args and returns clean UTF-8 output', async () => {
    const spawnCalls: Array<{ command: string; args: readonly string[]; cwd?: string }> = [];
    const tool = powerShellTool(
      async (command, args = [], options) => {
        spawnCalls.push({ command, args, cwd: options?.cwd });
        return processWithOutput({ stdout: '中文测试ABC\r\n第二行\r\n' });
      },
      async () => ({ path: 'C:\\pwsh.exe', kind: 'pwsh' }),
    );

    const result = await executeTool(tool, { command: "Write-Output '中文测试ABC'" });

    expect(result.isError).toBe(false);
    expect(result.output).toContain('中文测试ABC\n第二行\n');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.command).toBe('C:\\pwsh.exe');
    expect(decodePowerShellArgs(spawnCalls[0]!.args)).toContain("Write-Output '中文测试ABC'");
  });

  it('reports a non-zero exit code faithfully', async () => {
    const tool = powerShellTool(
      async () => processWithOutput({ exitCode: 3 }),
      async () => ({ path: 'C:\\pwsh.exe', kind: 'pwsh' }),
    );
    const result = await executeTool(tool, { command: 'exit 3' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('Command failed with exit code: 3.');
  });

  it('surfaces executable resolution failures as tool errors', async () => {
    const tool = powerShellTool(
      async () => processWithOutput({}),
      async () => {
        throw new Error('PowerShell was not found on this Windows host.');
      },
    );
    const result = await executeTool(tool, { command: 'Get-Date' });
    expect(result.isError).toBe(true);
    expect(result.output).toContain('PowerShell was not found');
  });
});
