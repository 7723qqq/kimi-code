import { describe, expect, it } from 'vitest';

import type { ServiceIdentifier, ServicesAccessor } from '#/_base/di/instantiation';
import { IInstantiationService } from '#/_base/di/instantiation';
import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { type IAgentScopeHandle, LifecycleScope } from '#/_base/di/scope';
import { Emitter } from '#/_base/event';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { createHooks } from '#/hooks';
import {
  type AgentTaskHooks,
  IAgentLifecycleService,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionTodoService } from '#/session/todo/sessionTodo';
import { SessionTodoService } from '#/session/todo/sessionTodoService';
import { type TodoItem } from '#/session/todo/todoItem';
import { TODO_LIST_REMINDER_VARIANT } from '#/session/todo/todoListReminder';
import { IAgentWireService, type IWireService } from '#/wire';

interface RecordedTodoSet {
  readonly todos: readonly TodoItem[];
}

interface FakeAgent {
  readonly handle: IAgentScopeHandle;
  readonly registeredTools: string[];
  readonly registeredVariants: string[];
  readonly appended: RecordedTodoSet[];
  readonly resumers: Array<(record: RecordedTodoSet) => void>;
}

function makeFakeAgent(agentId: string): FakeAgent {
  const registeredTools: string[] = [];
  const registeredVariants: string[] = [];
  const appended: RecordedTodoSet[] = [];
  const resumers: Array<(record: RecordedTodoSet) => void> = [];

  const registryStub = {
    _serviceBrand: undefined,
    register: (tool: { name: string }) => {
      registeredTools.push(tool.name);
      return toDisposable(() => {});
    },
    list: () => [],
    resolve: () => undefined,
    hooks: {},
  };

  const injectorStub = {
    _serviceBrand: undefined,
    register: (variant: string) => {
      registeredVariants.push(variant);
      return toDisposable(() => {});
    },
  };

  const instantiationStub = {
    createInstance: (ctor: { name: string }) => ({ name: ctor.name }),
  };

  const memoryStub = {
    _serviceBrand: undefined,
    get: () => [],
  };

  const profileStub = {
    _serviceBrand: undefined,
    isToolActive: () => false,
  };

  let todoState: readonly TodoItem[] = [];
  const wireStub: IWireService = {
    _serviceBrand: undefined,
    dispatch: (...ops: unknown[]) => {
      for (const raw of ops) {
        const op = raw as { type: string; payload: unknown };
        const payload = op.payload;
        if (payload !== null && typeof payload === 'object' && !Array.isArray(payload)) {
          const record = payload as Record<string, unknown>;
          if (Array.isArray(record['todos'])) {
            todoState = record['todos'] as readonly TodoItem[];
          }
          appended.push({ type: op.type, ...record } as unknown as RecordedTodoSet);
        } else {
          appended.push({ type: op.type, payload } as unknown as RecordedTodoSet);
        }
      }
    },
    replay: async () => {},
    signal: () => {},
    flush: async () => {},
    attach: () => toDisposable(() => {}),
    getModel: () => todoState,
    subscribe: () => toDisposable(() => {}),
    onEmission: () => toDisposable(() => {}),
    onRestored: (handler: () => void) => {
      resumers.push((record: RecordedTodoSet) => {
        todoState = record.todos;
        handler();
      });
      return toDisposable(() => {});
    },
  } as unknown as IWireService;

  const accessor: ServicesAccessor = {
    get: <T>(id: ServiceIdentifier<T>): T => {
      if (id === IAgentToolRegistryService) return registryStub as unknown as T;
      if (id === IAgentContextInjectorService) return injectorStub as unknown as T;
      if (id === IInstantiationService) return instantiationStub as unknown as T;
      if (id === IAgentContextMemoryService) return memoryStub as unknown as T;
      if (id === IAgentProfileService) return profileStub as unknown as T;
      if (id === IAgentWireService) return wireStub as unknown as T;
      throw new Error(`unexpected service request in fake agent: ${String(id)}`);
    },
  };

  const handle: IAgentScopeHandle = {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor,
    dispose: () => {},
  };

  return { handle, registeredTools, registeredVariants, appended, resumers };
}

interface LifecycleStub {
  readonly service: IAgentLifecycleService;
  readonly fireCreate: (handle: IAgentScopeHandle) => void;
  readonly fireCreateMain: (handle: IAgentScopeHandle) => void;
  readonly fireDispose: (agentId: string) => void;
}

function makeLifecycleStub(handles: readonly IAgentScopeHandle[] = []): LifecycleStub {
  const onDidCreate = new Emitter<IAgentScopeHandle>();
  const onDidCreateMain = new Emitter<IAgentScopeHandle>();
  const onDidDispose = new Emitter<string>();
  const byId = new Map(handles.map((h) => [h.id, h]));

  const service: IAgentLifecycleService = {
    _serviceBrand: undefined,
    hooks: createHooks<AgentTaskHooks, keyof AgentTaskHooks>([
      'onWillStartAgentTask',
      'onDidStopAgentTask',
    ]),
    onDidCreate: onDidCreate.event,
    onDidCreateMain: onDidCreateMain.event,
    onDidDispose: onDidDispose.event,
    getHandle: (id: string) => byId.get(id),
    list: () => [...byId.values()],
    create: async () => {
      throw new Error('not implemented');
    },
    ensureMcpReady: () => Promise.resolve(),
    notifyMainCreated: () => {},
    fork: async () => {
      throw new Error('not implemented');
    },
    run: () => {
      throw new Error('not implemented');
    },
    remove: async () => {},
  };

  return {
    service,
    fireCreate: (h) => {
      byId.set(h.id, h);
      onDidCreate.fire(h);
    },
    fireCreateMain: (h) => {
      byId.set(h.id, h);
      onDidCreateMain.fire(h);
    },
    fireDispose: (id) => {
      byId.delete(id);
      onDidDispose.fire(id);
    },
  };
}

describe('SessionTodoService', () => {
  it('starts empty and updates in-memory list on setTodos', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);

    expect(service.getTodos()).toEqual([]);

    const next: TodoItem[] = [
      { title: 'a', status: 'pending' },
      { title: 'b', status: 'in_progress' },
    ];
    service.setTodos(next);
    expect(service.getTodos()).toEqual(next);

    service.clear();
    expect(service.getTodos()).toEqual([]);
  });

  it('fires onDidChange after each setTodos', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);

    const seen: Array<readonly TodoItem[]> = [];
    const d = service.onDidChange((todos) => seen.push(todos));
    service.setTodos([{ title: 'x', status: 'pending' }]);
    service.setTodos([{ title: 'y', status: 'done' }]);
    d.dispose();

    expect(seen).toEqual([
      [{ title: 'x', status: 'pending' }],
      [{ title: 'y', status: 'done' }],
    ]);
  });

  it('appends a todo.set record to the main agent wire on setTodos', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    service.setTodos([{ title: 'persist me', status: 'in_progress' }]);

    expect(main.appended).toEqual([
      { type: 'todo.set', todos: [{ title: 'persist me', status: 'in_progress' }] },
    ]);
  });

  it('does not append to the wire when the main agent is absent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    // Should not throw even without a main agent.
    expect(() => service.setTodos([{ title: 'x', status: 'pending' }])).not.toThrow();
    expect(service.getTodos()).toEqual([{ title: 'x', status: 'pending' }]);
  });

  it('binds the stale-todo reminder into every created agent', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    void service;

    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    lifecycle.fireCreate(main.handle);
    lifecycle.fireCreate(sub.handle);

    // The TodoList tool itself is contributed via `registerTool` and registered
    // by the Agent-scope builtin-tools registrar — SessionTodoService only owns
    // the per-agent reminder.
    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    expect(sub.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
  });

  it('registers the todo.set resume resumer only on the main agent', () => {
    const main = makeFakeAgent('main');
    const sub = makeFakeAgent('agent-1');
    const lifecycle = makeLifecycleStub([main.handle, sub.handle]);
    const service = new SessionTodoService(lifecycle.service);
    void service;

    expect(main.resumers).toHaveLength(1);
    expect(sub.resumers).toHaveLength(0);
  });

  it('rebuilds the in-memory list when a todo.set record is resumed', () => {
    const main = makeFakeAgent('main');
    const lifecycle = makeLifecycleStub([main.handle]);
    const service = new SessionTodoService(lifecycle.service);

    const resumer = main.resumers[0];
    expect(resumer).toBeDefined();
    resumer!({ todos: [{ title: 'restored', status: 'done' }] });

    expect(service.getTodos()).toEqual([{ title: 'restored', status: 'done' }]);
  });

  it('disposes per-agent bindings when the agent is disposed', () => {
    const lifecycle = makeLifecycleStub();
    const service = new SessionTodoService(lifecycle.service);
    const main = makeFakeAgent('main');
    lifecycle.fireCreate(main.handle);

    expect(main.registeredVariants).toContain(TODO_LIST_REMINDER_VARIANT);
    // Disposal should not throw and should leave the service usable.
    expect(() => lifecycle.fireDispose('main')).not.toThrow();
    expect(service.getTodos()).toEqual([]);
  });

  it('satisfies the ISessionTodoService contract', () => {
    const lifecycle = makeLifecycleStub();
    const service: ISessionTodoService = new SessionTodoService(lifecycle.service);
    expect(typeof service.getTodos).toBe('function');
    expect(typeof service.setTodos).toBe('function');
    expect(typeof service.clear).toBe('function');
    expect(typeof service.onDidChange).toBe('function');
  });
});
