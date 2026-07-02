import {
  Disposable,
} from "#/_base/di";
import { IInstantiationService } from "#/_base/di/instantiation";
import {
  TODO_LIST_TOOL_NAME,
  TODO_STORE_KEY,
  TodoListTool,
  readTodoItems,
  type TodoItem,
} from '#/agent/todoList/tools/todo-list';
import {
  TODO_LIST_REMINDER_VARIANT,
  todoListStaleReminder,
} from './todoListReminder';
import { IAgentContextMemoryService } from '#/agent/contextMemory';
import { IAgentContextInjectorService } from '#/agent/contextInjector';
import { IAgentProfileService } from '#/agent/profile';
import { IAgentToolRegistryService } from '#/agent/toolRegistry';
import { IAgentToolStoreService } from '#/agent/toolStore';
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
    @IInstantiationService private readonly instantiationService: IInstantiationService,
  ) {
    super();
    this._register(toolRegistry.register(instantiationService.createInstance(TodoListTool)));
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
