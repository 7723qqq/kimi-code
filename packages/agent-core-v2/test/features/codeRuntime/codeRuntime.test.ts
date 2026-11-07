import { describe, expect, it, mock } from 'bun:test';

import type { IConfigService } from '#/app/config/config';
import { classifyCodeExit, runCodeInSubprocess } from '#/features/codeRuntime/codeExecutor';
import { createWindowsGuard, MEMORY_CAP_BYTES, type Win32Kernel32 } from '#/features/codeRuntime/memoryGuard';
import { RunCodeTool } from '#/features/codeRuntime/runCodeTool';

interface FakeKernel32 extends Win32Kernel32 {
  readonly calls: string[];
  readonly queryBuffers: ArrayBuffer[];
  readonly setBuffers: ArrayBuffer[];
  readonly assignPid: number | undefined;
}

function makeFakeKernel32(peakJobMemoryBytes: number): FakeKernel32 {
  const calls: string[] = [];
  const queryBuffers: ArrayBuffer[] = [];
  const setBuffers: ArrayBuffer[] = [];
  let assignPid: number | undefined;
  const job = {};
  const processHandle = {};
  const api = {
    calls,
    queryBuffers,
    setBuffers,
    get assignPid() {
      return assignPid;
    },
    CreateJobObjectW: () => {
      calls.push('CreateJobObjectW');
      return job;
    },
    SetInformationJobObject: (
      _job: unknown,
      infoClass: number,
      info: ArrayBuffer,
      size: number,
    ) => {
      calls.push(`SetInformationJobObject:${String(infoClass)}:${String(size)}`);
      setBuffers.push(info);
      return true;
    },
    AssignProcessToJobObject: (_job: unknown, _process: unknown) => {
      calls.push('AssignProcessToJobObject');
      assignPid = 4321;
      return true;
    },
    QueryInformationJobObject: (
      _job: unknown,
      infoClass: number,
      info: ArrayBuffer,
      size: number,
      _retLen: unknown,
    ) => {
      calls.push(`QueryInformationJobObject:${String(infoClass)}:${String(size)}`);
      queryBuffers.push(info);
      new DataView(info).setBigUint64(128, 123n, true);
      new DataView(info).setBigUint64(136, BigInt(peakJobMemoryBytes), true);
      return true;
    },
    OpenProcess: () => {
      calls.push('OpenProcess');
      return processHandle;
    },
    CloseHandle: () => {
      calls.push('CloseHandle');
      return true;
    },
  };
  return api as unknown as FakeKernel32;
}

describe('Windows memory guard route', () => {
  it('assigns the process and reads PeakJobMemoryUsed through the extended-limit route', () => {
    const k32 = makeFakeKernel32(MEMORY_CAP_BYTES);
    const guard = createWindowsGuard(4321, MEMORY_CAP_BYTES, k32);

    expect(k32.calls).toEqual([
      'CreateJobObjectW',
      'SetInformationJobObject:9:144',
      'OpenProcess',
      'AssignProcessToJobObject',
    ]);
    const limits = new DataView(k32.setBuffers[0]!);
    expect(limits.getUint32(16, true)).toBe(0x100 | 0x200 | 0x2000);
    expect(limits.getBigUint64(112, true)).toBe(BigInt(MEMORY_CAP_BYTES));
    expect(limits.getBigUint64(120, true)).toBe(BigInt(MEMORY_CAP_BYTES));

    expect(guard.exceeded()).toBe(true);
    expect(k32.calls[4]).toBe('QueryInformationJobObject:9:144');
    const query = new DataView(k32.queryBuffers[0]!);
    expect(query.getBigUint64(136, true)).toBe(BigInt(MEMORY_CAP_BYTES));

    guard.dispose();
    expect(k32.calls.slice(-2)).toEqual(['CloseHandle', 'CloseHandle']);
  });

  it('does not classify a worker exit as memory-limit when the job peak stays below the cap', () => {
    const k32 = makeFakeKernel32(MEMORY_CAP_BYTES - 1);
    const guard = createWindowsGuard(4321, MEMORY_CAP_BYTES, k32);

    expect(guard.exceeded()).toBe(false);
    expect(classifyCodeExit({
      memoryLimitExceeded: guard.exceeded(),
      outputLimitHit: false,
      exitCode: 3,
      stderr: 'oh no: Bun has run out of memory.',
    }).kind).toBe('worker-exit');
  });

  it('keeps the last known peak when a query fails after the cap was reached', () => {
    const k32 = makeFakeKernel32(MEMORY_CAP_BYTES);
    const query = mock(() => true);
    k32.QueryInformationJobObject = (
      _job: unknown,
      infoClass: number,
      info: ArrayBuffer,
      size: number,
      _retLen: unknown,
    ) => {
      k32.calls.push(`QueryInformationJobObject:${String(infoClass)}:${String(size)}`);
      k32.queryBuffers.push(info);
      if (!query()) return false;
      new DataView(info).setBigUint64(136, BigInt(MEMORY_CAP_BYTES), true);
      return true;
    };
    const guard = createWindowsGuard(4321, MEMORY_CAP_BYTES, k32);

    expect(guard.exceeded()).toBe(true);
    query.mockImplementation(() => false);
    expect(guard.exceeded()).toBe(true);
  });
});

describe('code exit classification route', () => {
  const route = {
    memoryLimitExceeded: false,
    outputLimitHit: false,
    exitCode: 3,
    stderr: 'oh no: Bun has run out of memory.',
  };

  it('takes output-limit before memory-limit before worker-exit', () => {
    expect(classifyCodeExit({ ...route, outputLimitHit: true }).kind).toBe('output-limit');
    expect(classifyCodeExit({ ...route, memoryLimitExceeded: true }).kind).toBe('memory-limit');
    expect(classifyCodeExit(route).kind).toBe('worker-exit');
  });

  it('never uses a peak-near-cap heuristic to reach memory-limit', () => {
    expect(classifyCodeExit({ ...route, memoryLimitExceeded: false }).kind).toBe('worker-exit');
    expect(classifyCodeExit({ ...route, memoryLimitExceeded: true, outputLimitHit: true }).kind).toBe('output-limit');
  });

  it('keeps stderr on the worker-exit route and off the memory-limit route', () => {
    expect(classifyCodeExit(route).message).toContain('oh no: Bun has run out of memory.');
    expect(classifyCodeExit({ ...route, memoryLimitExceeded: true }).message).not.toContain('oh no');
  });
});

describe('runCodeInSubprocess', () => {
  it('runs a program and returns its JSON completion value', async () => {
    const outcome = await runCodeInSubprocess('return 1 + 2;');
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe(3);
    expect(outcome.logs).toEqual([]);
  });

  it('captures console output in emission order', async () => {
    const outcome = await runCodeInSubprocess(`
      console.log('first');
      console.info('second');
      console.warn({ a: 1 });
      return 'done';
    `);
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBe('done');
    expect(outcome.logs).toHaveLength(3);
    expect(outcome.logs[0]).toBe('first');
    expect(outcome.logs[1]).toBe('second');
    expect(outcome.logs[2]).toContain('a: 1');
  });

  it('supports top-level await', async () => {
    const outcome = await runCodeInSubprocess(`
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { waited: true };
    `);
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toEqual({ waited: true });
  });

  it('reports a thrown exception with its stack', async () => {
    const outcome = await runCodeInSubprocess("throw new Error('boom');");
    expect(outcome.error?.kind).toBe('exception');
    expect(outcome.error?.message).toContain('boom');
  });

  it('rejects non-JSON completion values', async () => {
    const outcome = await runCodeInSubprocess('return () => 1;');
    expect(outcome.error?.kind).toBe('invalid-output');
  });

  it('treats a bare return as value: undefined without error', async () => {
    const outcome = await runCodeInSubprocess('const x = 1; return;');
    expect(outcome.error).toBeUndefined();
    expect(outcome.value).toBeUndefined();
  });

  it('terminates a runaway program after the timeout', async () => {
    const outcome = await runCodeInSubprocess('await new Promise(() => {});', {
      timeoutMs: 1_000,
    });
    expect(outcome.error?.kind).toBe('timeout');
    expect(outcome.error?.message).toContain('1000ms');
  });

  it('settles as cancelled when the caller aborts', async () => {
    const controller = new AbortController();
    const run = runCodeInSubprocess('await new Promise(() => {});', {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    const outcome = await run;
    expect(outcome.error?.kind).toBe('cancelled');
  });

  it('reports a program that calls process.exit() as worker-exit instead of hanging', async () => {
    const outcome = await runCodeInSubprocess("console.log('bye'); process.exit(0);", {
      timeoutMs: 5_000,
    });
    expect(outcome.error?.kind).toBe('worker-exit');
    expect(outcome.error?.message).toContain('exit');
    expect(outcome.logs).toContain('bye');
  });

  it('reports a program that kills itself mid-run as worker-exit instead of hanging', async () => {
    const outcome = await runCodeInSubprocess(
      "console.log('before-crash'); process.kill(process.pid, 'SIGKILL');",
      { timeoutMs: 5_000 },
    );
    expect(outcome.error?.kind).toBe('worker-exit');
    expect(outcome.logs).toContain('before-crash');
  });

  it('fails with output-limit when logs exhaust the shared budget', async () => {
    const outcome = await runCodeInSubprocess(
      `
      for (let i = 0; i < 1000; i++) console.log('line-' + i);
      return 'ok';
    `,
      { maxOutputChars: 2000 },
    );
    expect(outcome.error?.kind).toBe('output-limit');
    expect(outcome.logs.join('\n').length).toBeLessThanOrEqual(2000);
  });

  it('terminates a runaway allocation with memory-limit before the timeout', async () => {
    const started = Date.now();
    const outcome = await runCodeInSubprocess(
      'const a = []; while (true) a.push(new Array(100000).fill(1));',
      { timeoutMs: 60_000 },
    );
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(outcome.error?.kind).toBe('memory-limit');
  });

  it('keeps the host usable after a subprocess dies from memory pressure', async () => {
    const crashed = await runCodeInSubprocess(
      'const a = []; while (true) a.push(new Array(100000).fill(1));',
      { timeoutMs: 60_000 },
    );
    expect(crashed.error).toBeDefined();
    const after = await runCodeInSubprocess('return 1 + 2;');
    expect(after.error).toBeUndefined();
    expect(after.value).toBe(3);
  });
});

describe('RunCodeTool', () => {
  const configStub = {
    _serviceBrand: undefined,
    get: () => undefined,
  } as unknown as IConfigService;

  it('exposes the run_code tool contract and renders results', async () => {
    const tool = new RunCodeTool(configStub);
    expect(tool.name).toBe('run_code');
    expect((tool.parameters['properties'] as Record<string, unknown>)['code']).toBeDefined();

    const execution = tool.resolveExecution({
      code: "console.log('hi'); return { n: 42 };",
      timeout_ms: 30_000,
    });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    expect(execution.description).toContain('subprocess');
    const result = await execution.execute({
      toolCallId: 't1',
      signal: new AbortController().signal,
    } as Parameters<typeof execution.execute>[0]);
    expect(result.isError).toBe(false);
    expect(result.output).toContain('value: {"n":42}');
    expect(result.output).toContain('logs:');
    expect(result.output).toContain('hi');
  });

  it('marks a failing program as an error result', async () => {
    const tool = new RunCodeTool(configStub);
    const execution = tool.resolveExecution({
      code: "throw new Error('nope');",
      timeout_ms: 30_000,
    });
    if (!('execute' in execution)) throw new Error('expected a runnable execution');
    const result = await execution.execute({
      toolCallId: 't2',
      signal: new AbortController().signal,
    } as Parameters<typeof execution.execute>[0]);
    expect(result.isError).toBe(true);
    expect(result.output).toContain('error (exception)');
    expect(result.output).toContain('nope');
  });
});
