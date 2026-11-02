import { describe, expect, it } from 'bun:test';

import type { IConfigService } from '#/app/config/config';
import { runCodeInSubprocess } from '#/features/codeRuntime/codeExecutor';
import { RunCodeTool } from '#/features/codeRuntime/runCodeTool';

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
