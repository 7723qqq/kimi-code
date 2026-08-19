import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { HostProcessService } from '#/os/backends/node-local/hostProcessService';
import {
  HostProcessError,
  HostProcessErrorCode,
  IHostProcessService,
} from '#/os/interface/hostProcess';

async function collect(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

describe('HostProcessService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
  });

  afterEach(() => {
    disposables.dispose();
  });

  it('spawns a process and captures stdout + exit code', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write("ok")']);
    const out = await collect(proc.stdout);
    expect(out).toBe('ok');
    expect(await proc.wait()).toBe(0);
    expect(proc.exitCode).toBe(0);
  });

  it('passes env overrides to the child', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'process.stdout.write(process.env.FOO ?? "")'], {
      env: { FOO: 'bar' },
    });
    const out = await collect(proc.stdout);
    expect(out).toBe('bar');
    expect(await proc.wait()).toBe(0);
  });

  it('throws a coded error when the command does not exist', async () => {
    const svc = ix.get(IHostProcessService);
    await expect(svc.spawn('definitely-not-a-real-command-42')).rejects.toSatisfy(
      (err: unknown) => {
        expect(err).toBeInstanceOf(HostProcessError);
        const error = err as HostProcessError;
        expect(error.code).toBe(HostProcessErrorCode.SpawnFailed);
        expect(error.code).toBe('os.process.spawn_failed');
        expect(error.details).toMatchObject({
          command: 'definitely-not-a-real-command-42',
          errno: 'ENOENT',
        });
        expect(error.cause).toBeInstanceOf(Error);
        return true;
      },
    );
  });

  it('terminates a running process with kill()', async () => {
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('node', ['-e', 'setTimeout(() => {}, 30000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await proc.kill('SIGTERM');
    const code = await proc.wait();
    expect(code).not.toBe(0);
  });
});

describe.skipIf(process.platform !== 'win32')('HostProcessService (Windows)', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let tempDir: string;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(IHostProcessService, HostProcessService);
      },
    });
    tempDir = mkdtempSync(join(tmpdir(), 'kimi-hostproc-'));
  });

  afterEach(() => {
    disposables.dispose();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('runs extensionless .cmd shims found via PATHEXT through cmd.exe', async () => {
    writeFileSync(join(tempDir, 'fakecmd.cmd'), '@echo fake-ok\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('fakecmd', [], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out.trim()).toBe('fake-ok');
    expect(await proc.wait()).toBe(0);
  });

  it('preserves argument boundaries through the cmd.exe wrapper', async () => {
    writeFileSync(join(tempDir, 'argcmd.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('argcmd', ['hello world', 'x"y'], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out).toContain('["hello world"]');
    expect(out).toContain('["x""y"]');
    expect(await proc.wait()).toBe(0);
  });

  it('preserves a trailing backslash inside a quoted argument', async () => {
    writeFileSync(join(tempDir, 'argcmd.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('argcmd', ['C:\\Program Files\\', 'plain'], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out).toContain('["C:\\Program Files\\\\"]');
    expect(await proc.wait()).toBe(0);
  });

  it('preserves a quote followed by a trailing backslash', async () => {
    writeFileSync(join(tempDir, 'argcmd.cmd'), '@echo off\r\necho [%1][%2]\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn('argcmd', ['a"b\\', 'plain'], {
      env: { PATH: `${tempDir};${process.env['PATH'] ?? ''}` },
    });
    const out = await collect(proc.stdout);
    expect(out).toContain('["a""b\\\\"]');
    expect(await proc.wait()).toBe(0);
  });

  it('runs an explicitly named .cmd file through cmd.exe', async () => {
    writeFileSync(join(tempDir, 'explicit.cmd'), '@echo explicit-ok\r\n');
    const svc = ix.get(IHostProcessService);
    const proc = await svc.spawn(join(tempDir, 'explicit.cmd'), []);
    const out = await collect(proc.stdout);
    expect(out.trim()).toBe('explicit-ok');
    expect(await proc.wait()).toBe(0);
  });
});
