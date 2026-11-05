import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';

async function viWaitFor(fn: () => void | Promise<void>, opts?: { timeout?: number }): Promise<void> {
  const deadline = Date.now() + (opts?.timeout ?? 1000);
  for (;;) {
    try {
      await fn();
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 10));
    }
  }
}


import { afterAll, beforeAll, describe, expect, it } from 'bun:test';

import { ConnectionClosedError } from '#/remote/protocol/errors';
import { RemoteSession } from '#/remote/client/remoteSession';
import { TEST_VERSION } from './helpers/loopback';

const require = createRequire(import.meta.url);
const here = import.meta.dirname;


function loopbackLauncher() {
  return {
    type: 'command' as const,
    program: process.execPath,
    args: [join(here, 'fixtures', 'exec-server-child.ts')],
    env: { EXEC_SERVER_VERSION: TEST_VERSION },
  };
}

describe.skipIf(process.platform === 'win32')('RemoteSession over a subprocess loopback', () => {
  let workDir: string;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'remote-exec-environment-'));
  });

  afterAll(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('exposes the handshake host and runs the fs/process chain', async () => {
    const session = await RemoteSession.connect({
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    try {
      expect(session.executorVersion).toBe(TEST_VERSION);
      expect(session.host.osKind.length).toBeGreaterThan(0);
      expect(session.host.pathClass).toBe(process.platform === 'win32' ? 'win32' : 'posix');
      expect(session.host.shellPath.length).toBeGreaterThan(0);
      expect(session.host.homeDir.length).toBeGreaterThan(0);
      expect(session.host.cwd.length).toBeGreaterThan(0);
      expect(session.host.tempDir.length).toBeGreaterThan(0);
      expect(session.fs).toBeDefined();
      expect(session.process).toBeDefined();

      const file = join(workDir, 'chain.txt');
      await session.fs.writeText(file, 'chain-data');
      const proc = await session.process.spawn(process.execPath, [
        '-e',
        'process.stdout.write(require("node:fs").readFileSync(process.argv[1], "utf8"))',
        file,
      ], { cwd: workDir });
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      const ended = new Promise<void>((resolve) => {
        proc.stdout.on('end', () => {
          resolve();
        });
      });
      await proc.wait();
      await ended;
      expect(Buffer.concat(chunks).toString()).toBe('chain-data');
    } finally {
      await session.dispose();
    }
  });

  it('lets the executor kill TERM-resistant children before disposing the launcher', async () => {
    const session = await RemoteSession.connect({ environmentId: 'loopback', launcher: loopbackLauncher() });
    let pid: number | undefined;
    const alive = (): boolean => {
      try { process.kill(pid!, 0); return true; } catch { return false; }
    };
    try {
      const proc = await session.process.spawn(process.execPath, ['-e',
        'process.on("SIGTERM", () => {}); process.stdout.write("ready"); setInterval(() => {}, 1000)',
      ], { cwd: workDir });
      pid = proc.pid;
      await new Promise<void>((resolve) => {
        proc.stdout.once('data', () => { resolve(); });
      });
      await session.dispose();
      await viWaitFor(() => { expect(alive()).toBe(false); }, { timeout: 5_000 });
    } finally {
      await session.dispose();
      if (pid !== undefined && alive()) process.kill(pid, 'SIGKILL');
    }
  });

  it('reports the closed connection and rejects new calls after dispose', async () => {
    const session = await RemoteSession.connect({
      environmentId: 'loopback',
      launcher: loopbackLauncher(),
    });
    const closed: string[] = [];
    session.connection.onDidClose((info) => {
      closed.push(info.kind ?? 'other');
    });
    const proc = await session.process.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
    expect(proc.pid).toBeGreaterThan(0);
    await session.dispose();
    expect(closed).toEqual(['client_closed']);
    await expect(session.process.spawn(process.execPath)).rejects.toThrow(ConnectionClosedError);
  });

  it.skipIf(process.platform === 'win32')('uses the real askpass helper for a password retry', { timeout: 60_000 }, async () => {
    const binDir = await mkdtemp(join(tmpdir(), 'remote-ssh-password-'));
    const password = 'päss "word"';
    const argsPath = join(binDir, 'args');
    const fakeSsh = join(binDir, 'ssh');
    await writeFile(fakeSsh, `#!/bin/sh
printf '%s\\n' "$@" > "$TEST_ARGS_FILE"
if [ -z "\${SSH_ASKPASS:-}" ]; then
  printf 'Permission denied (publickey,password)\\n' >&2
  exit 255
fi
provided="$("$SSH_ASKPASS" 'Password:')"
if [ "$provided" != "$EXPECTED_SSH_PASSWORD" ]; then
  printf 'Permission denied (publickey,password)\\n' >&2
  exit 255
fi
case "$*" in
  *"uname -s"*) printf 'Linux\n'; exit 0 ;;
esac
exec "$TEST_NODE" "$TEST_SERVER"
`);
    await chmod(fakeSsh, 0o700);
    process.env['PATH'] = `${binDir}:${process.env['PATH'] ?? ''}`;
    process.env['SSH_ASKPASS'] = '';
    process.env['TEST_ARGS_FILE'] = argsPath;
    process.env['EXPECTED_SSH_PASSWORD'] = password;
    process.env['TEST_NODE'] = process.execPath;
    process.env['TEST_TSX'] = '';
    process.env['TEST_SERVER'] = join(here, 'fixtures', 'exec-server-child.ts');
    process.env['EXEC_SERVER_VERSION'] = TEST_VERSION;

    let session: RemoteSession | undefined;
    try {
      await expect(RemoteSession.connect({
        environmentId: 'dev-box',
        launcher: { type: 'ssh', host: 'dev-box' },
      })).rejects.toMatchObject({ kind: 'authentication' });

      session = await RemoteSession.connect({
        environmentId: 'dev-box',
        launcher: { type: 'ssh', host: 'dev-box' },
        sshAuth: {
          password,
          command: [process.execPath, join(here, 'fixtures', 'ssh-askpass-child.ts')],
        },
      });
      expect(session.executorVersion).toBe(TEST_VERSION);
      const args = await readFile(argsPath, 'utf8');
      expect(args).toContain('BatchMode=no');
      expect(args).toContain('NumberOfPasswordPrompts=1');
      expect(args).toContain('StrictHostKeyChecking=accept-new');
      expect(args).not.toContain('BatchMode=yes');
    } finally {
      await session?.dispose();
      await rm(binDir, { recursive: true, force: true });
    }
  });
});
