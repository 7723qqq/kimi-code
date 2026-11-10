import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import type { IAgentEnvironmentService } from '#/agent/environmentBinding/agentEnvironment';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { WillExecuteToolEvent } from '#/agent/toolExecutor/toolHooks';
import type { IBootstrapService } from '#/app/bootstrap/bootstrap';
import type { IEventBus } from '#/app/event/eventBus';
import { FileSnapshotStore } from '#/features/snapshot/fileSnapshotStore';
import {
  pickSnapshot,
  resolveSnapshotTarget,
  type SnapshotRecord,
} from '#/features/snapshot/snapshot';
import { SnapshotService } from '#/features/snapshot/snapshotService';
import type { IHostClock } from '#/os/interface/hostClock';
import type { ISessionContext } from '#/session/sessionContext/sessionContext';
import { hostWorkspacePathSemantics } from '#/session/workspaceContext/workspacePaths';

import { stubWorkspaceContext } from '../../session/workspaceContext/stub-workspace-context';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-snapshot-'));
  roots.push(root);
  return root;
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function recordVersion(
  store: FileSnapshotStore,
  path: string,
  text: string,
  agentId: string,
  at: number,
): Promise<SnapshotRecord> {
  return store.record({
    path,
    at: new Date(at),
    tool: 'Write',
    mode: 'overwrite',
    size: bytesOf(text).byteLength,
    bytes: bytesOf(text),
    sessionId: 'ses_test',
    agentId,
  });
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('FileSnapshotStore', () => {
  it('recovers the version two agents raced to write', async () => {
    const root = await tempRoot();
    const target = join(root, 'src', 'loop.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    await recordVersion(store, target, 'version written by a', 'agent-a', 1_000);
    await recordVersion(store, target, 'version written by b', 'agent-b', 2_000);

    const records = await store.list(target);
    expect(records.map((record) => record.agentId)).toEqual(['agent-b', 'agent-a']);

    const overwritten = pickSnapshot(records, { previous: true });
    expect(overwritten?.agentId).toBe('agent-b');
    const restored = await store.content(overwritten!.hash);
    expect(new TextDecoder().decode(restored ?? new Uint8Array())).toBe('version written by b');

    const author = records[records.indexOf(overwritten!) + 1];
    expect(author?.agentId).toBe('agent-a');
  });

  it('keeps every record when writers race on one path', async () => {
    const root = await tempRoot();
    const target = join(root, 'race.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        recordVersion(
          store,
          target,
          `body ${String(index)}`,
          `agent-${String(index)}`,
          10_000 + index,
        ),
      ),
    );

    const records = await store.list(target);
    expect(records).toHaveLength(25);
    const bodies = await Promise.all(
      records.map(async (record) => {
        const bytes = await store.content(record.hash);
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      }),
    );
    expect(bodies.every((body) => body !== undefined)).toBe(true);
    expect(new Set(bodies).size).toBe(25);
  });

  it('stores identical content once', async () => {
    const root = await tempRoot();
    const target = join(root, 'same.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const first = await recordVersion(store, target, 'same bytes', 'agent-a', 1_000);
    await recordVersion(store, target, 'same bytes', 'agent-b', 2_000);
    const bucket = await readdir(
      join(root, 'store', 'snapshots', 'objects', first.hash.slice(0, 2)),
    );
    expect(bucket).toEqual([first.hash]);
  });

  it('refuses to return an object whose bytes do not match its hash', async () => {
    const root = await tempRoot();
    const target = join(root, 'corrupt.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));
    const record = await recordVersion(store, target, 'expected body', 'agent-a', 1_000);
    const object = join(
      root,
      'store',
      'snapshots',
      'objects',
      record.hash.slice(0, 2),
      record.hash,
    );
    await writeFile(object, 'truncated');

    expect(await store.content(record.hash)).toBeUndefined();
  });

  it('records a skipped entry instead of dropping an oversized file', async () => {
    const root = await tempRoot();
    const target = join(root, 'big.bin');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const record = await store.record({
      path: target,
      at: new Date(1_000),
      tool: 'Write',
      mode: 'overwrite',
      skipped: 'max-size',
      size: 9_000_000,
      sessionId: 'ses_test',
      agentId: 'agent-a',
    });

    expect(record.hash).toBe('');
    expect(record.skipped).toBe('max-size');
    const records = await store.list(target);
    expect(pickSnapshot(records, { previous: true })).toBeUndefined();
  });

  it('marks a swarm subagent by session and agent', async () => {
    const root = await tempRoot();
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    await store.markAgent({
      agentId: 'agent-b',
      sessionId: 'ses_test',
      at: new Date(2_000),
      cwd: root,
      parentAgentId: 'main',
      profileName: 'coder',
      swarmIndex: 3,
    });

    const marks = await store.agents('ses_test');
    expect(marks).toHaveLength(1);
    expect(marks[0]).toMatchObject({ agentId: 'agent-b', parentAgentId: 'main', swarmIndex: 3 });
  });

  it('prunes agent marks beyond the retention age', async () => {
    const root = await tempRoot();
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));
    for (const [agentId, at] of [
      ['agent-old', 1_000],
      ['agent-new', 9_000],
    ] as const) {
      await store.markAgent({ agentId, sessionId: 'ses_test', at: new Date(at), cwd: root });
    }

    const result = await store.prune({
      now: new Date(10_000),
      maxPerPath: 100,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 5_000,
      minObjectAgeMs: 0,
    });

    expect(result.agentMarksRemoved).toBe(1);
    expect((await store.agents('ses_test')).map((mark) => mark.agentId)).toEqual(['agent-new']);
  });

  it('records the hash of what the write left behind', async () => {
    const root = await tempRoot();
    const target = join(root, 'after.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const record = await recordVersion(store, target, 'before', 'agent-a', 1_000);
    expect(record.afterHash).toBeUndefined();

    expect(
      await store.complete(target, record.id, {
        hash: new Bun.CryptoHasher('sha256').update(bytesOf('after')).digest('hex'),
        size: 5,
      }),
    ).toBe(true);
    const [updated] = await store.list(target);
    expect(updated?.afterHash).toBe(
      new Bun.CryptoHasher('sha256').update(bytesOf('after')).digest('hex'),
    );
    expect(updated?.afterSize).toBe(5);
    expect(await store.complete(target, '0000000009999-missing', { hash: 'x', size: 1 })).toBe(
      false,
    );
  });

  it('removes a record by id', async () => {
    const root = await tempRoot();
    const target = join(root, 'drop.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const record = await recordVersion(store, target, 'body', 'agent-a', 1_000);
    expect(await store.remove(target, record.id)).toBe(true);
    expect(await store.list(target)).toHaveLength(0);
    expect(await store.remove(target, record.id)).toBe(false);
  });

  it('keeps the newest versions and reclaims their objects', async () => {
    const root = await tempRoot();
    const target = join(root, 'prune.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    for (let index = 0; index < 6; index += 1) {
      await recordVersion(store, target, `body ${String(index)}`, 'agent-a', 1_000 + index);
    }

    const result = await store.prune({
      now: new Date(10_000),
      maxPerPath: 2,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 60_000,
      minObjectAgeMs: 0,
    });

    expect(result.recordsRemoved).toBe(4);
    expect(result.objectsRemoved).toBe(4);
    const records = await store.list(target);
    expect(records).toHaveLength(2);
    const bodies = await Promise.all(
      records.map(async (record) => {
        const bytes = await store.content(record.hash);
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      }),
    );
    expect(bodies).toEqual(['body 5', 'body 4']);
  });

  it('keeps the newest record even when it is past the age limit', async () => {
    const root = await tempRoot();
    const target = join(root, 'old.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    await recordVersion(store, target, 'first', 'agent-a', 1_000);
    await recordVersion(store, target, 'second', 'agent-b', 2_000);

    const result = await store.prune({
      now: new Date(10_000_000),
      maxPerPath: 100,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 1,
      minObjectAgeMs: 0,
    });

    expect(result.recordsRemoved).toBe(1);
    const records = await store.list(target);
    expect(records).toHaveLength(1);
    expect(records[0]?.agentId).toBe('agent-b');
  });

  it('reclaims only the objects nothing references any more', async () => {
    const root = await tempRoot();
    const first = join(root, 'first.ts');
    const second = join(root, 'second.ts');
    const third = join(root, 'third.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const shared = await recordVersion(store, first, 'shared body', 'agent-a', 1_000);
    await recordVersion(store, first, 'later body', 'agent-a', 2_000);
    await recordVersion(store, second, 'shared body', 'agent-b', 3_000);
    await recordVersion(store, third, 'orphan old', 'agent-c', 4_000);
    const orphan = await recordVersion(store, third, 'orphan new', 'agent-c', 5_000);

    const result = await store.prune({
      now: new Date(10_000),
      maxPerPath: 1,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 60_000,
      minObjectAgeMs: 0,
    });

    expect(result.recordsRemoved).toBe(2);
    expect(result.objectsRemoved).toBe(1);
    expect(await store.content(shared.hash)).toBeDefined();
    expect(await store.content(orphan.hash)).toBeDefined();
  });

  it('records the file mtime the write saw', async () => {
    const root = await tempRoot();
    const target = join(root, 'mtime.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const record = await store.record({
      path: target,
      at: new Date(1_000),
      tool: 'Write',
      mode: 'overwrite',
      size: 4,
      bytes: bytesOf('body'),
      mtimeMs: 1_234_567,
    });

    expect(record.mtimeMs).toBe(1_234_567);
    const [listed] = await store.list(target);
    expect(listed?.mtimeMs).toBe(1_234_567);
  });

  it('drops the oldest versions past the byte budget', async () => {
    const root = await tempRoot();
    const target = join(root, 'budget.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));
    const chunk = 'x'.repeat(1_000);

    for (let index = 0; index < 3; index += 1) {
      await recordVersion(store, target, chunk, `agent-${String(index)}`, 1_000 + index);
    }

    const result = await store.prune({
      now: new Date(10_000),
      maxPerPath: 100,
      maxBytesPerPath: 1_500,
      maxAgeMs: 60_000,
      minObjectAgeMs: 0,
    });

    expect(result.recordsRemoved).toBe(2);
    const records = await store.list(target);
    expect(records).toHaveLength(1);
    expect(records[0]?.agentId).toBe('agent-2');
  });

  it('keeps a large log readable and prunable', async () => {
    const root = await tempRoot();
    const target = join(root, 'scale.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));
    const started = performance.now();

    for (let base = 0; base < 800; base += 40) {
      await Promise.all(
        Array.from({ length: 40 }, (_, offset) =>
          recordVersion(
            store,
            target,
            `body ${String(base + offset)}`,
            'agent-a',
            1_000 + base + offset,
          ),
        ),
      );
    }

    expect(await store.list(target)).toHaveLength(800);
    const pruned = await store.prune({
      now: new Date(10_000),
      maxPerPath: 50,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 10 ** 12,
      minObjectAgeMs: 0,
    });

    expect(pruned.recordsRemoved).toBe(750);
    expect(await store.list(target)).toHaveLength(50);
    expect(performance.now() - started).toBeLessThan(20_000);
  });

  it('does not reclaim an object written during the sweep window', async () => {
    const root = await tempRoot();
    const target = join(root, 'fresh.ts');
    const store = new FileSnapshotStore(join(root, 'store', 'snapshots'));

    const fresh = await recordVersion(store, target, 'fresh body', 'agent-a', 1_000);
    const now = new Date(1_000);

    const guarded = await store.prune({
      now,
      maxPerPath: 0,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 60_000,
      minObjectAgeMs: 60_000,
    });
    expect(guarded.objectsRemoved).toBe(0);
    expect(await store.content(fresh.hash)).toBeDefined();

    const swept = await store.prune({
      now,
      maxPerPath: 0,
      maxBytesPerPath: Number.MAX_SAFE_INTEGER,
      maxAgeMs: 60_000,
      minObjectAgeMs: 0,
    });
    expect(swept.objectsRemoved).toBe(1);
    expect(await store.content(fresh.hash)).toBeUndefined();
  });
});

describe('pickSnapshot', () => {
  const records = [
    { id: '0000000003000-aaaa', hash: 'ccc', skipped: undefined },
    { id: '0000000002000-bbbb', hash: 'cbb', skipped: undefined },
    { id: '0000000001000-cccc', hash: 'aaa', skipped: undefined },
  ] as unknown as SnapshotRecord[];

  it('resolves a unique hash prefix', () => {
    expect(pickSnapshot(records, { hash: 'cc' })?.id).toBe('0000000003000-aaaa');
  });

  it('refuses an ambiguous prefix', () => {
    expect(pickSnapshot(records, { hash: 'c' })).toBeUndefined();
  });

  it('skips entries that never stored content', () => {
    const withSkip = [
      { id: '0000000003000-aaaa', hash: '', skipped: 'max-size' },
      { id: '0000000002000-bbbb', hash: 'bbb', skipped: undefined },
    ] as unknown as SnapshotRecord[];
    expect(pickSnapshot(withSkip, { previous: true })?.id).toBe('0000000002000-bbbb');
  });
});

describe('resolveSnapshotTarget', () => {
  it('snapshots an overwrite write', () => {
    const display = { kind: 'file_io', operation: 'write', path: '/tmp/a.ts' };
    expect(resolveSnapshotTarget(display as never, { mode: 'overwrite' })).toEqual({
      path: '/tmp/a.ts',
      tool: 'write',
      mode: 'overwrite',
    });
  });

  it('skips append, which destroys nothing', () => {
    const display = { kind: 'file_io', operation: 'write', path: '/tmp/a.ts' };
    expect(resolveSnapshotTarget(display as never, { mode: 'append' })).toBeUndefined();
  });

  it('snapshots an edit', () => {
    const display = { kind: 'file_io', operation: 'edit', path: '/tmp/a.ts' };
    expect(resolveSnapshotTarget(display as never, {})?.mode).toBe('edit');
  });

  it('ignores a read display', () => {
    const display = { kind: 'file_io', operation: 'read', path: '/tmp/a.ts' };
    expect(resolveSnapshotTarget(display as never, {})).toBeUndefined();
  });
});

describe('SnapshotService', () => {
  interface ServiceHarness {
    readonly service: SnapshotService;
    readonly target: string;
    fire(callId: string, content?: string): Promise<void>;
    didExecute(callId: string, outcome: string, failed?: boolean): Promise<void>;
    write(next: string): void;
  }

  async function serviceHarness(body: Uint8Array): Promise<ServiceHarness> {
    const root = await tempRoot();
    const target = join(root, 'edited.ts');
    let current = body;
    let willHandler: ((event: WillExecuteToolEvent) => void) | undefined;
    let didHandler:
      | ((
          context: { toolCall: { id: string }; outcome: string; result: { isError?: boolean } },
          next: () => Promise<void>,
        ) => Promise<void>)
      | undefined;

    const service = new SnapshotService(
      {
        _serviceBrand: undefined,
        agentId: 'agent-b',
        scope: () => 'scope',
      } as unknown as IAgentScopeContext,
      {
        _serviceBrand: undefined,
        sessionId: 'ses_test',
        workspaceId: 'ws',
        sessionDir: root,
        metaScope: '',
        cwd: root,
        scope: () => 'scope',
      } as unknown as ISessionContext,
      { storeDir: join(root, 'store') } as unknown as IBootstrapService,
      {
        acquireWhenReady: () =>
          Promise.resolve({
            environment: {
              fs: {
                stat: () =>
                  Promise.resolve({ isFile: true, isDirectory: false, size: current.byteLength }),
                readBytes: () => Promise.resolve(current),
              },
              path: hostWorkspacePathSemantics,
            },
            dispose: () => {},
          }),
      } as unknown as IAgentEnvironmentService,
      stubWorkspaceContext(root),
      { now: () => new Date(5_000), timeZone: () => 'UTC' } as unknown as IHostClock,
      {
        onWillExecuteTool: (next: (event: WillExecuteToolEvent) => void) => {
          willHandler = next;
          return { dispose: () => {} };
        },
        hooks: {
          onDidExecuteTool: {
            register: (
              _id: string,
              next: (
                context: { toolCall: { id: string }; outcome: string },
                proceed: () => Promise<void>,
              ) => Promise<void>,
            ) => {
              didHandler = next;
              return { dispose: () => {} };
            },
          },
        },
      } as unknown as IAgentToolExecutorService,
      { subscribe: () => ({ dispose: () => {} }) } as unknown as IEventBus,
    );

    return {
      service,
      target,
      async fire(callId: string, content?: string): Promise<void> {
        const pending: Promise<void>[] = [];
        willHandler!({
          turnId: 1,
          toolCall: { type: 'function', id: callId, name: 'Write', arguments: null },
          execution: { display: { kind: 'file_io', operation: 'write', path: target } },
          args: content === undefined ? { mode: 'overwrite' } : { mode: 'overwrite', content },
          waitUntil: (task: Promise<void>) => {
            pending.push(task);
          },
        } as unknown as WillExecuteToolEvent);
        await Promise.all(pending);
      },
      async didExecute(callId: string, outcome: string, failed = false): Promise<void> {
        await didHandler!({ toolCall: { id: callId }, outcome, result: { isError: failed } }, () =>
          Promise.resolve(),
        );
      },
      write(next: string): void {
        current = bytesOf(next);
      },
    };
  }

  it('captures the pre-image with the writing agent before the tool runs', async () => {
    const harness = await serviceHarness(bytesOf('const value = 1;\n'));
    await harness.fire('call-1');

    const records = await harness.service.store.list(harness.target);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      agentId: 'agent-b',
      sessionId: 'ses_test',
      mode: 'overwrite',
    });
    const captured = await harness.service.store.content(records[0]!.hash);
    expect(new TextDecoder().decode(captured ?? new Uint8Array())).toBe('const value = 1;\n');

    harness.write('const value = 2;\n');
    await harness.didExecute('call-1', 'executed');
    const completed = await harness.service.store.list(harness.target);
    expect(completed[0]?.afterHash).toBe(
      new Bun.CryptoHasher('sha256').update(bytesOf('const value = 2;\n')).digest('hex'),
    );
    expect(completed[0]?.afterSize).toBe(17);
  });

  it('uses the content the tool is about to write instead of reading it back', async () => {
    const harness = await serviceHarness(bytesOf('const value = 1;\n'));
    await harness.fire('call-3', 'const value = 9;\n');
    await harness.didExecute('call-3', 'executed');

    const [record] = await harness.service.store.list(harness.target);
    expect(record?.afterHash).toBe(
      new Bun.CryptoHasher('sha256').update(bytesOf('const value = 9;\n')).digest('hex'),
    );
    expect(record?.afterSize).toBe(17);
  });

  it('drops the record when the write never ran', async () => {
    const harness = await serviceHarness(bytesOf('const value = 1;\n'));
    await harness.fire('call-2');
    expect(await harness.service.store.list(harness.target)).toHaveLength(1);

    await harness.didExecute('call-2', 'vetoed');
    expect(await harness.service.store.list(harness.target)).toHaveLength(0);
  });

  it('drops the pre-image when the tool reports a failed write', async () => {
    const harness = await serviceHarness(bytesOf('const value = 1;\n'));
    await harness.fire('call-failed');

    await harness.didExecute('call-failed', 'executed', true);

    expect(await harness.service.store.list(harness.target)).toHaveLength(0);
  });

  it('keeps the pre-image when a failed tool still changed the file', async () => {
    const harness = await serviceHarness(bytesOf('version zero'));
    await harness.fire('call-partial', 'version a');
    harness.write('version a');

    await harness.didExecute('call-partial', 'executed', true);

    const records = await harness.service.store.list(harness.target);
    expect(records).toHaveLength(1);
    expect(records[0]?.afterHash).toBe(
      new Bun.CryptoHasher('sha256').update(bytesOf('version a')).digest('hex'),
    );
    const bytes = await harness.service.store.content(records[0]!.hash);
    expect(new TextDecoder().decode(bytes ?? new Uint8Array())).toBe('version zero');
  });

  it('lists a relative path against the same absolute snapshot target', async () => {
    const harness = await serviceHarness(bytesOf('const value = 1;\n'));
    await harness.fire('call-relative');
    await harness.didExecute('call-relative', 'executed');

    expect(await harness.service.list('edited.ts')).toHaveLength(1);
  });

  it('keeps the pre-image and intermediate version of overlapping writes', async () => {
    const harness = await serviceHarness(bytesOf('version zero'));
    const first = harness.fire('call-first', 'version a');
    const second = harness.fire('call-second', 'version b');
    await first;
    harness.write('version a');
    await harness.didExecute('call-first', 'executed');
    await second;
    harness.write('version b');
    await harness.didExecute('call-second', 'executed');

    const records = await harness.service.store.list(harness.target);
    const bodies = await Promise.all(
      records.map(async (record) => {
        const bytes = await harness.service.store.content(record.hash);
        return bytes === undefined ? undefined : new TextDecoder().decode(bytes);
      }),
    );
    expect(new Set(bodies)).toEqual(new Set(['version zero', 'version a']));
  });
});
