import type { IDisposable } from '#/_base/di/lifecycle';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { defineAgentEffect, type AgentEffectContext } from '#/state/agentEffect';

import type { TodoItem } from './todoItem';
import { todoActiveReminder, todoListStaleReminder } from './todoListReminder';

export interface TodoAgentEffectContext extends AgentEffectContext {
  getTodos(): readonly TodoItem[];
  getHistory(): readonly ContextMessage[];
  isToolActive(): boolean;
  registerReminder(provider: () => string | undefined): IDisposable;
  registerActiveReminder(provider: () => string | undefined): IDisposable;
  subscribeChange(listener: (todos: readonly TodoItem[]) => void): IDisposable;
  subscribeUndo(listener: () => void): IDisposable;
  onChange(todos: readonly TodoItem[]): void;
}

export const TodoAgentEffectDefinition = defineAgentEffect({
  id: 'todo.reminder',
  create: (context: TodoAgentEffectContext) => {
    let lastKnown = context.getTodos();
    const reminder = context.registerReminder(() =>
      todoListStaleReminder({
        active: context.isToolActive(),
        history: context.getHistory(),
        todos: context.getTodos(),
      }),
    );
    const active = context.registerActiveReminder(() =>
      context.isToolActive() ? todoActiveReminder(context.getTodos()) : undefined,
    );
    const change = context.subscribeChange((todos) => {
      lastKnown = todos;
    });
    const undo = context.subscribeUndo(() => {
      const current = context.getTodos();
      if (todoItemsEqual(current, lastKnown)) return;
      context.onChange(current);
    });
    return {
      dispose: () => {
        undo.dispose();
        change.dispose();
        active.dispose();
        reminder.dispose();
      },
    };
  },
});

function todoItemsEqual(a: readonly TodoItem[], b: readonly TodoItem[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (item, index) =>
        item.title === b[index]?.title &&
        item.status === b[index]?.status &&
        item.progress === b[index]?.progress &&
        item.description === b[index]?.description &&
        item.kind === b[index]?.kind &&
        item.parentId === b[index]?.parentId,
    )
  );
}
