import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DisposableStore } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { Emitter } from '#/_base/event';
import { ErrorCodes } from '#/errors';
import { ISessionContext, makeSessionContext } from '#/session/sessionContext';
import {
  type TerminalAttachSink,
  type TerminalFrame,
  type TerminalProcess,
  type TerminalSpawnOptions,
  ISessionTerminalBackend,
  ISessionTerminalService,
} from '#/session/terminal';
import { SessionTerminalService } from '#/os/backends/node-local/terminalService';
import { ISessionWorkspaceContext } from '#/session/workspaceContext';

class FakeTerminalProcess implements TerminalProcess {
  private readonly dataEmitter = new Emitter<string>();
  private readonly exitEmitter = new Emitter<{ exitCode: number | null }>();
  readonly onData = this.dataEmitter.event;
  readonly onExit = this.exitEmitter.event;
  readonly writes: string[] = [];
  readonly resizes: Array<[number, number]> = [];
  killed = false;

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resizes.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    this.dataEmitter.fire(data);
  }
  emitExit(exitCode: number | null): void {
    this.exitEmitter.fire({ exitCode });
  }
  dispose(): void {
    this.dataEmitter.dispose();
    this.exitEmitter.dispose();
  }
}

class FakeTerminalBackend implements ISessionTerminalBackend {
  declare readonly _serviceBrand: undefined;
  readonly processes: FakeTerminalProcess[] = [];
  readonly lastOptions: TerminalSpawnOptions[] = [];

  spawn(options: TerminalSpawnOptions): Promise<TerminalProcess> {
    this.lastOptions.push(options);
    const proc = new FakeTerminalProcess();
    this.processes.push(proc);
    return Promise.resolve(proc);
  }
}

function stubWorkspace(workDir = '/ws'): ISessionWorkspaceContext {
  return {
    _serviceBrand: undefined,
    workDir,
    additionalDirs: [],
    setWorkDir: () => {},
    resolve: (rel) => resolve(workDir, rel),
    isWithin: () => true,
    assertAllowed: (absPath) => resolve(workDir, absPath),
    addAdditionalDir: () => {},
    removeAdditionalDir: () => {},
  };
}

function stubSessionContext(sessionId = 's1'): ISessionContext {
  return makeSessionContext({
    sessionId,
    workspaceId: 'w1',
    sessionDir: '/ws/.session',
    sessionScope: `session:${sessionId}`,
    metaScope: `session:${sessionId}`,
  });
}

function collectSink(id = 'sink-1'): { sink: TerminalAttachSink; frames: TerminalFrame[] } {
  const frames: TerminalFrame[] = [];
  return { sink: { id, send: (frame) => frames.push(frame) }, frames };
}

describe('SessionTerminalService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let backend: FakeTerminalBackend;

  beforeEach(() => {
    disposables = new DisposableStore();
    backend = new FakeTerminalBackend();
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.define(ISessionTerminalService, SessionTerminalService);
        reg.defineInstance(ISessionTerminalBackend, backend);
        reg.defineInstance(ISessionWorkspaceContext, stubWorkspace());
        reg.defineInstance(ISessionContext, stubSessionContext());
      },
    });
  });
  afterEach(() => disposables.dispose());

  it('creates a terminal and resolves cwd through the workspace', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({ cwd: 'sub', cols: 100, rows: 40 });

    expect(terminal.status).toBe('running');
    expect(terminal.session_id).toBe('s1');
    expect(terminal.cwd).toBe(resolve('/ws', 'sub'));
    expect(terminal.cols).toBe(100);
    expect(terminal.rows).toBe(40);
    expect(backend.processes).toHaveLength(1);
    expect(backend.lastOptions[0]?.cwd).toBe(resolve('/ws', 'sub'));
  });

  it('uses the workspace workDir when cwd is omitted', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    expect(terminal.cwd).toBe('/ws');
    expect(terminal.cols).toBe(80);
    expect(terminal.rows).toBe(24);
  });

  it('lists and gets terminals', async () => {
    const svc = ix.get(ISessionTerminalService);
    const created = await svc.create({});
    const listed = await svc.list();
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe(created.id);

    const fetched = await svc.get(created.id);
    expect(fetched.id).toBe(created.id);
  });

  it('throws TERMINAL_NOT_FOUND for an unknown terminal', async () => {
    const svc = ix.get(ISessionTerminalService);
    await expect(svc.get('nope')).rejects.toMatchObject({
      code: ErrorCodes.TERMINAL_NOT_FOUND,
    });
  });

  it('attaches a sink, replays buffered frames, then streams live output', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = backend.processes[0]!;

    proc.emitData('hello');
    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink);
    expect(replayed).toBe(1);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'terminal_output',
      seq: 1,
      session_id: 's1',
      terminal_id: terminal.id,
      payload: { data: 'hello' },
    });

    proc.emitData('world');
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ type: 'terminal_output', seq: 2, payload: { data: 'world' } });
  });

  it('replays only frames after sinceSeq', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = backend.processes[0]!;
    proc.emitData('a');
    proc.emitData('b');
    proc.emitData('c');

    const { sink, frames } = collectSink();
    const { replayed } = await svc.attach(terminal.id, sink, { sinceSeq: 1 });
    expect(replayed).toBe(2);
    expect(frames.map((f) => (f as { seq?: number }).seq)).toEqual([2, 3]);
  });

  it('emits an exit frame and marks the terminal exited on process exit', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = backend.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    proc.emitExit(7);

    const exitFrame = frames.find((f) => f.type === 'terminal_exit');
    expect(exitFrame).toMatchObject({
      type: 'terminal_exit',
      terminal_id: terminal.id,
      payload: { exit_code: 7 },
    });
    const fetched = await svc.get(terminal.id);
    expect(fetched.status).toBe('exited');
    expect(fetched.exit_code).toBe(7);
  });

  it('delegates write and resize to the process', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = backend.processes[0]!;

    await svc.write(terminal.id, 'ls\n');
    await svc.resize(terminal.id, 120, 50);

    expect(proc.writes).toEqual(['ls\n']);
    expect(proc.resizes).toEqual([[120, 50]]);
    expect((await svc.get(terminal.id)).cols).toBe(120);
  });

  it('closes a terminal by killing the process and marking it exited', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = backend.processes[0]!;

    const result = await svc.close(terminal.id);
    expect(result).toEqual({ closed: true });
    expect(proc.killed).toBe(true);
    expect((await svc.get(terminal.id)).status).toBe('exited');
  });

  it('detaches a sink so it stops receiving frames', async () => {
    const svc = ix.get(ISessionTerminalService);
    const terminal = await svc.create({});
    const proc = backend.processes[0]!;
    const { sink, frames } = collectSink();
    await svc.attach(terminal.id, sink);

    svc.detach(terminal.id, sink.id);
    proc.emitData('after-detach');
    expect(frames).toHaveLength(0);
  });

  it('kills every live process when the service is disposed', async () => {
    const svc = ix.get(ISessionTerminalService);
    await svc.create({});
    const proc = backend.processes[0]!;

    disposables.dispose();
    expect(proc.killed).toBe(true);
  });
});
