import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { join } from 'pathe';

import {
  OPERATION_LOG_DEFAULT_MAX_TOTAL_BYTES,
  OPERATION_LOG_MAX_AGE_MS,
  OPERATION_LOG_MAX_OPERATIONS,
  type OperationView,
} from '#/features/operationLog/operationLog';
import { OperationLogStore } from '#/features/operationLog/operationLogStore';

const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'kimi-operation-log-'));
  roots.push(root);
  return root;
}

function view(tree: string): OperationView {
  const target = `commit-${tree}`;
  return {
    tree,
    head: { kind: 'branch', ref: 'refs/heads/main', target },
    refs: { 'refs/heads/main': target },
    indexTree: `index-${tree}`,
  };
}

function at(milliseconds: number): Date {
  return new Date(milliseconds);
}

function action(milliseconds: number) {
  return { at: at(milliseconds), description: `operation ${String(milliseconds)}` };
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return error;
  }
}

afterAll(async () => {
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })));
});

describe('OperationLogStore', () => {
  it('uses the confirmed operation limits and a tunable byte recommendation', () => {
    expect(OPERATION_LOG_MAX_OPERATIONS).toBe(1000);
    expect(OPERATION_LOG_MAX_AGE_MS).toBe(30 * 24 * 60 * 60 * 1000);
    expect(OPERATION_LOG_DEFAULT_MAX_TOTAL_BYTES).toBe(1024 * 1024 * 1024);
  });

  it('persists immutable operations and reopens the linear head', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);
    const first = await store.capture(view('tree-a'), action(1_000));
    const second = await store.capture(view('tree-b'), action(2_000));
    const firstBeforeReopen = await readFile(
      join(root, 'operations', first.id.slice(0, 2), `${first.id}.json`),
      'utf8',
    );

    const reopened = new OperationLogStore(root);
    expect(await reopened.head()).toMatchObject({
      operationId: second.id,
      undoTargetId: second.id,
      redoStack: [],
    });
    expect(await reopened.get(first.id)).toEqual(first);
    expect(await reopened.view(first.viewId)).toEqual(view('tree-a'));
    expect((await reopened.list()).map((operation) => operation.id)).toEqual([second.id, first.id]);
    expect(second.beforeViewId).toBe(first.viewId);
    expect(second.parents).toEqual([first.id]);
    expect(
      await readFile(join(root, 'operations', first.id.slice(0, 2), `${first.id}.json`), 'utf8'),
    ).toBe(firstBeforeReopen);
  });

  it('supports successive undo and redo by appending new operations', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);
    const first = await store.capture(view('tree-a'), action(1_000));
    const second = await store.capture(view('tree-b'), action(2_000));
    const third = await store.capture(view('tree-c'), action(3_000));

    const undoThird = await store.undo(action(4_000));
    const undoSecond = await store.undo(action(5_000));
    expect(undoThird.kind).toBe('undo');
    expect(undoThird.targetId).toBe(third.id);
    expect(undoThird.viewId).toBe(second.viewId);
    expect(undoSecond.targetId).toBe(second.id);
    expect(undoSecond.viewId).toBe(first.viewId);
    expect((await store.get(third.id)).viewId).toBe(third.viewId);

    const redoSecond = await store.redo(action(6_000));
    const redoThird = await store.redo(action(7_000));
    expect(redoSecond.kind).toBe('redo');
    expect(redoSecond.targetId).toBe(second.id);
    expect(redoSecond.viewId).toBe(second.viewId);
    expect(redoThird.targetId).toBe(third.id);
    expect(redoThird.viewId).toBe(third.viewId);
    expect(await store.head()).toMatchObject({ redoStack: [] });
    expect((await store.list()).map((operation) => operation.id)).toEqual([
      redoThird.id,
      redoSecond.id,
      undoSecond.id,
      undoThird.id,
      third.id,
      second.id,
      first.id,
    ]);
  });

  it('restores an arbitrary view and clears the redo stack', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);
    const first = await store.capture(view('tree-a'), action(1_000));
    const second = await store.capture(view('tree-b'), action(2_000));
    await store.capture(view('tree-c'), action(3_000));
    await store.undo(action(4_000));

    const restored = await store.restore(first.id, action(5_000));
    expect(restored.kind).toBe('restore');
    expect(restored.targetId).toBe(first.id);
    expect(restored.viewId).toBe(first.viewId);
    expect(restored.beforeViewId).toBe(second.viewId);
    expect(
      await store.redo(action(6_000)).then(
        () => undefined,
        (error: unknown) => error,
      ),
    ).toMatchObject({ code: 'nothing-to-redo' });

    const undoneRestore = await store.undo(action(7_000));
    expect(undoneRestore.targetId).toBe(restored.id);
    expect(undoneRestore.viewId).toBe(second.viewId);
  });

  it('records a before view on the first changed operation so it can be undone', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);

    const captured = await store.capture(view('tree-b'), action(2_000), view('tree-a'));
    const beforeViewId = captured.beforeViewId;
    if (beforeViewId === undefined) throw new Error('Missing before view id');
    expect(await store.view(beforeViewId)).toEqual(view('tree-a'));

    const undone = await store.undo(action(3_000));
    expect(undone.viewId).toBe(beforeViewId);
    expect(await store.view(undone.viewId)).toEqual(view('tree-a'));
  });

  it('rejects a capture whose before view differs from the current head view', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);
    await store.capture(view('tree-b'), action(1_000), view('tree-a'));

    expect(
      await rejectionOf(store.capture(view('tree-d'), action(2_000), view('tree-c'))),
    ).toMatchObject({ code: 'view-mismatch' });
    expect(await store.list()).toHaveLength(1);
  });

  it('rejects an operation beyond the count limit without deleting history', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root, { maxOperations: 2 });
    await store.capture(view('tree-a'), action(1_000));
    await store.capture(view('tree-b'), action(2_000));

    expect(await rejectionOf(store.capture(view('tree-c'), action(3_000)))).toMatchObject({
      code: 'retention-exceeded',
      details: { limit: 'operations', maximum: 2 },
    });
    expect(await store.list()).toHaveLength(2);
  });

  it('rejects new operations after the age limit without deleting history', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);
    await store.capture(view('tree-a'), action(1_000));

    expect(
      await rejectionOf(
        store.capture(view('tree-b'), action(1_000 + OPERATION_LOG_MAX_AGE_MS + 1)),
      ),
    ).toMatchObject({
      code: 'retention-exceeded',
      details: { limit: 'age', maximum: OPERATION_LOG_MAX_AGE_MS },
    });
    expect(await store.list()).toHaveLength(1);
  });

  it('rejects the byte cap before writing and permits an explicit override', async () => {
    const root = await tempRoot();
    const limited = new OperationLogStore(root, { maxTotalBytes: 1 });

    expect(await rejectionOf(limited.capture(view('tree-a'), action(1_000)))).toMatchObject({
      code: 'retention-exceeded',
      details: { limit: 'bytes', maximum: 1 },
    });
    expect(await limited.head()).toBeUndefined();

    const reopened = new OperationLogStore(root, { maxTotalBytes: 1024 * 1024 });
    expect(await reopened.capture(view('tree-a'), action(2_000))).toMatchObject({
      kind: 'capture',
    });
    expect(await reopened.list()).toHaveLength(1);
  });

  it('serializes concurrent appends into one linear history', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);

    await Promise.all(
      Array.from({ length: 25 }, (_, index) =>
        store.capture(view(`tree-${String(index)}`), action(1_000 + index)),
      ),
    );

    const operations = await store.list();
    expect(operations).toHaveLength(25);
    for (let index = 0; index < operations.length - 1; index += 1) {
      expect(operations[index]?.parents[0]).toBe(operations[index + 1]?.id);
    }
  });

  it('fails closed when a stored view no longer matches its content hash', async () => {
    const root = await tempRoot();
    const store = new OperationLogStore(root);
    const operation = await store.capture(view('tree-a'), action(1_000));
    const path = join(root, 'views', operation.viewId.slice(0, 2), `${operation.viewId}.json`);
    await writeFile(path, '{}\n', 'utf8');

    expect(await rejectionOf(store.view(operation.viewId))).toMatchObject({ code: 'corrupt' });
  });
});
