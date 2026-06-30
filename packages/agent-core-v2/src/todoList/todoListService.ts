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
import { IAgentContextMemoryService } from '#/contextMemory';
import { IAgentContextInjectorService } from '../contextInjector';
import { IAgentProfileService } from '#/profile';
import { IAgentToolRegistryService } from '#/toolRegistry';
import { IAgentToolStoreService } from '#/toolStore';
import { IAgentTodoListService } from './todoList';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class AgentTodoListService extends Disposable implements IAgentTodoListService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentToolStoreService private readonly toolStore: IAgentToolStoreService,
    @IAgentToolRegistryService toolRegistry: IAgentToolRegistryService,
    @IAgentContextInjectorService dynamicInjector: IAgentContextInjectorService,
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
  IAgentTodoListService,
  AgentTodoListService,
  InstantiationType.Eager,
  'todoList',
);
