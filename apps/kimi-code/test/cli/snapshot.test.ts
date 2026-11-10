import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { FileSnapshotStore } from '@moonshot-ai/agent-core-v2';
import type { ISnapshotStore } from '@moonshot-ai/agent-core-v2';
import { Command } from 'commander';
import { join } from 'pathe';

import { createProgram } from '#/cli/commands';
import { registerSnapshotCommand, type SnapshotCommandDeps } from '#/cli/v2/snapshot';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-snapshot-cli-'));
  roots.push(root);
  return root;
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

interface Harness {
  readonly out: string[];
  readonly err: string[];
  readonly codes: number[];
  readonly store: FileSnapshotStore;
  readonly target: string;
  run(argv: readonly string[]): Promise<void>;
}

async function harness(): Promise<Harness> {
  const root = await tempRoot();
  const target = join(root, 'file.ts');
  const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const deps: SnapshotCommandDeps = {
    stdout: { write: (chunk: string) => out.push(chunk) > 0 },
    stderr: { write: (chunk: string) => err.push(chunk) > 0 },
    exit: (code: number): never => {
      codes.push(code);
      throw new Error(`exit ${String(code)}`);
    },
    store: () => Promise.resolve(store),
    resolvePath: (path: string) => (path === target ? target : join(root, path)),
    readFile: async (path: string) => {
      try {
        return await readFile(path);
      } catch {
        return undefined;
      }
    },
    writeFile: (path: string, bytes: Uint8Array) => writeFile(path, bytes),
  };
  return {
    out,
    err,
    codes,
    store,
    target,
    async run(argv: readonly string[]): Promise<void> {
      const program = new Command();
      program.exitOverride();
      program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
      registerSnapshotCommand(program, deps);
      try {
        await program.parseAsync(['node', 'kimi', 'snapshot', ...argv]);
      } catch {
        return;
      }
    },
  };
}

async function seed(harnessed: Harness): Promise<void> {
  const bodies = ['first body', 'second body', 'third body'];
  const hashes = bodies.map((body) =>
    new Bun.CryptoHasher('sha256').update(new TextEncoder().encode(body)).digest('hex'),
  );
  for (const [index, body] of bodies.entries()) {
    const record = await harnessed.store.record({
      path: harnessed.target,
      at: new Date(1_000 + index),
      tool: 'Write',
      mode: 'overwrite',
      size: Buffer.byteLength(body),
      bytes: new TextEncoder().encode(body),
      sessionId: 'ses_cli',
      agentId: `agent-${String(index)}`,
    });
    const after = hashes[index + 1];
    if (after !== undefined) {
      await harnessed.store.complete(harnessed.target, record.id, {
        hash: after,
        size: Buffer.byteLength(bodies[index + 1]!),
      });
    }
  }
}

describe('kimi snapshot', () => {
  it('lists versions newest first with the writer of each saved body', async () => {
    const cli = await harness();
    await seed(cli);

    await cli.run(['list', cli.target]);

    const rows = cli.out.join('').trim().split('\n');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toContain('destroyed-by=agent-2');
    expect(rows[0]).toContain('content-from=agent-1');
    expect(rows[2]).toContain('content-from=unknown');
  });

  it('restores the version the latest write replaced', async () => {
    const cli = await harness();
    await seed(cli);
    await writeFile(cli.target, 'current body');

    await cli.run(['restore', cli.target, '--previous']);

    expect(await readFile(cli.target, 'utf8')).toBe('third body');
    const text = cli.out.join('');
    expect(text).toContain('Restored');
    expect(text).toContain('written by agent-1');
  });

  it('refuses to guess which version to restore', async () => {
    const cli = await harness();
    await seed(cli);

    await cli.run(['restore', cli.target]);

    expect(cli.codes).toEqual([1]);
    expect(cli.err.join('')).toContain('--previous');
  });

  it('reports a missing version instead of writing an empty file', async () => {
    const cli = await harness();
    await seed(cli);
    await writeFile(cli.target, 'current body');

    await cli.run(['restore', cli.target, '--hash', 'deadbeef']);

    expect(cli.codes).toEqual([1]);
    expect(await readFile(cli.target, 'utf8')).toBe('current body');
  });

  it('attributes a version to the agent whose write produced it, not the row above', async () => {
    const cli = await harness();
    const first = await cli.store.record({
      path: cli.target,
      at: new Date(1_000),
      tool: 'Write',
      mode: 'overwrite',
      size: 2,
      bytes: new TextEncoder().encode('v0'),
      sessionId: 'ses_cli',
      agentId: 'agent-a',
    });
    await cli.store.complete(cli.target, first.id, {
      hash: new Bun.CryptoHasher('sha256').update(new TextEncoder().encode('v1')).digest('hex'),
      size: 2,
    });
    await cli.store.record({
      path: cli.target,
      at: new Date(2_000),
      tool: 'Write',
      mode: 'overwrite',
      size: 5,
      bytes: new TextEncoder().encode('other'),
      sessionId: 'ses_cli',
      agentId: 'agent-x',
    });
    await cli.store.record({
      path: cli.target,
      at: new Date(3_000),
      tool: 'Write',
      mode: 'overwrite',
      size: 2,
      bytes: new TextEncoder().encode('v1'),
      sessionId: 'ses_cli',
      agentId: 'agent-b',
    });

    await cli.run(['list', cli.target]);

    const rows = cli.out.join('').trim().split('\n');
    expect(rows[0]).toContain('destroyed-by=agent-b');
    expect(rows[0]).toContain('content-from=agent-a');
  });

  it('snapshots the content a restore is about to replace', async () => {
    const cli = await harness();
    await seed(cli);
    await writeFile(cli.target, 'current body');

    await cli.run(['restore', cli.target, '--previous']);

    const records = await cli.store.list(cli.target);
    expect(records[0]?.tool).toBe('Restore');
    expect(records[0]?.agentId).toBe('cli');
    const replaced = await cli.store.content(records[0]!.hash);
    expect(new TextDecoder().decode(replaced ?? new Uint8Array())).toBe('current body');
    expect(records[0]?.afterHash).toBe(records[1]?.hash);
  });

  it('prunes old versions and reports what it reclaimed', async () => {
    const cli = await harness();
    await seed(cli);
    await writeFile(cli.target, 'current body');

    await cli.run(['prune', '--max-per-path', '1']);

    expect(cli.out.join('')).toContain('Removed 2 records');
    expect(await cli.store.list(cli.target)).toHaveLength(1);
  });

  it('rejects a non-positive retention count without deleting records', async () => {
    const cli = await harness();
    await seed(cli);

    await cli.run(['prune', '--max-per-path', '0']);

    expect(cli.codes).toEqual([1]);
    expect(cli.err.join('')).toContain('--max-per-path');
    expect(await cli.store.list(cli.target)).toHaveLength(3);
  });

  it('is registered on the program the CLI actually builds', () => {
    const program = createProgram(
      '0.0.0-test',
      () => {},
      () => {},
    );
    expect(program.commands.map((command) => command.name())).toContain('snapshot');
  });
});
