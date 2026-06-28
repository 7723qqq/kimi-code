import {
  Disposable,
} from "#/_base/di";
import {
  TODO_LIST_TOOL_NAME,
  TODO_STORE_KEY,
  TodoListTool,
  readTodoItems,
  type TodoItem,
} from './tools/todo-list';
import {
  TODO_LIST_REMINDER_VARIANT,
  todoListStaleReminder,
} from './todoListReminder';
import { IContextMemory } from '#/contextMemory';
import { IContextInjector } from '../contextInjector';
import { IProfileService } from '#/profile';
import { IToolRegistry } from '#/toolRegistry';
import { IToolStoreService } from '#/toolStore';
import { ITodoListService } from './todoList';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class TodoListService extends Disposable implements ITodoListService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IContextMemory private readonly context: IContextMemory,
    @IProfileService private readonly profile: IProfileService,
    @IToolStoreService private readonly toolStore: IToolStoreService,
    @IToolRegistry toolRegistry: IToolRegistry,
    @IContextInjector dynamicInjector: IContextInjector,
  ) {
    super();
    this._register(toolRegistry.register(new TodoListTool(toolStore)));
    this._register(
      dynamicInjector.register(TODO_LIST_REMINDER_VARIANT, () => this.staleReminder()),
    );
  }

  private getTodos(): readonly TodoItem[] {
    return readTodoItems(this.toolStore.data()[TODO_STORE_KEY]);
  }

  private staleReminder(): string | undefined {
    return todoListStaleReminder({
      active: this.profile.isToolActive(TODO_LIST_TOOL_NAME, 'builtin'),
      history: this.context.get(),
      todos: this.getTodos(),
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  ITodoListService,
  TodoListService,
  InstantiationType.Eager,
  'todoList',
);
