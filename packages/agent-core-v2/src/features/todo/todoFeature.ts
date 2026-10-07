import { Feature } from '#/features/feature';
import { registerFeature } from '#/features/featureRegistry';
import { AgentTodoService, IAgentTodoService } from '#/features/todo/todoService';
import { ITodoListTool } from '#/features/todo/tools/todo-list/todo-list';
import { TodoListTool } from '#/features/todo/tools/todo-list/todoListTool';

export class TodoFeature extends Feature {
  static override readonly name = 'todo';

  constructor() {
    super();
    this.contributeAgentService(IAgentTodoService, AgentTodoService);
    this.contributeTool(ITodoListTool, TodoListTool, { name: 'TodoList', domain: 'todo' });
  }
}

registerFeature(TodoFeature);
