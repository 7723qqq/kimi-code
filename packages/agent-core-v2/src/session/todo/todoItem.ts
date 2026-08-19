export const TODO_LIST_TOOL_NAME = 'TodoList' as const;

export type TodoStatus = 'pending' | 'in_progress' | 'done';
export type TodoKind = 'milestone' | 'task';

export interface TodoItem {
  readonly id: string;
  readonly parentId: string | null;
  readonly kind: TodoKind;
  readonly title: string;
  readonly status: TodoStatus;
  readonly progress?: number;
  readonly description?: string;
}

export interface TodoProgressReport {
  readonly overall: number;
  readonly done: number;
  readonly total: number;
  readonly byId: ReadonlyMap<string, number>;
}

export function readTodoItems(raw: unknown): readonly TodoItem[] {
  if (!Array.isArray(raw)) return [];
  const items: TodoItem[] = [];
  for (const entry of raw) {
    if (!isRawTodoItem(entry)) continue;
    const progressRaw = entry['progress'];
    items.push({
      id: typeof entry['id'] === 'string' && entry['id'].length > 0 ? entry['id'] : '',
      parentId:
        typeof entry['parentId'] === 'string' && entry['parentId'].length > 0
          ? entry['parentId']
          : null,
      kind: entry['kind'] === 'milestone' ? 'milestone' : 'task',
      title: entry['title'],
      status: entry['status'],
      progress:
        typeof progressRaw === 'number' && Number.isFinite(progressRaw)
          ? Math.min(100, Math.max(0, Math.round(progressRaw)))
          : undefined,
      description: typeof entry['description'] === 'string' ? entry['description'] : undefined,
    });
  }
  return assignMissingIds(items);
}

function isRawTodoItem(
  value: unknown,
): value is { title: string; status: TodoStatus } & Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record['title'] === 'string' &&
    record['title'].length > 0 &&
    isTodoStatus(record['status'])
  );
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === 'pending' || value === 'in_progress' || value === 'done';
}

function assignMissingIds(items: readonly TodoItem[]): TodoItem[] {
  const used = new Set(items.filter((item) => item.id !== '').map((item) => item.id));
  const smallestFree = (format: (n: number) => string): string => {
    let n = 1;
    while (used.has(format(n))) n += 1;
    const id = format(n);
    used.add(id);
    return id;
  };
  return items.map((item) => {
    if (item.id !== '') return item;
    const id =
      item.parentId === null
        ? smallestFree((n) => `T${n}`)
        : smallestFree((n) => `${item.parentId}.${n}`);
    return { ...item, id };
  });
}

export function computeTodoProgress(todos: readonly TodoItem[]): TodoProgressReport {
  if (todos.length === 0) {
    return { overall: 0, done: 0, total: 0, byId: new Map() };
  }
  const childrenOf = new Map<string, TodoItem[]>();
  for (const todo of todos) {
    if (todo.parentId === null) continue;
    const list = childrenOf.get(todo.parentId) ?? [];
    list.push(todo);
    childrenOf.set(todo.parentId, list);
  }
  const byId = new Map<string, number>();
  for (const todo of todos) {
    if (todo.kind === 'milestone') continue;
    byId.set(todo.id, leafProgress(todo));
  }
  const milestones = todos.filter((todo) => todo.kind === 'milestone');
  if (milestones.length === 0) {
    const values = todos.map((todo) => byId.get(todo.id) ?? 0);
    return {
      overall: mean(values),
      done: todos.filter((todo) => todo.status === 'done').length,
      total: todos.length,
      byId,
    };
  }
  const milestoneValues: number[] = [];
  for (const milestone of milestones) {
    const children = childrenOf.get(milestone.id) ?? [];
    const value =
      children.length === 0
        ? leafProgress(milestone)
        : mean(children.map((child) => byId.get(child.id) ?? 0));
    byId.set(milestone.id, value);
    milestoneValues.push(value);
  }
  const done = todos.filter((todo) =>
    todo.kind === 'milestone' ? (byId.get(todo.id) ?? 0) >= 100 : todo.status === 'done',
  ).length;
  return {
    overall: mean(milestoneValues),
    done,
    total: todos.length,
    byId,
  };
}

function leafProgress(todo: TodoItem): number {
  if (todo.status === 'done') return 100;
  if (todo.status === 'in_progress') return todo.progress ?? 0;
  return 0;
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.round(values.reduce((acc, v) => acc + v, 0) / values.length);
}

export function renderTodoList(todos: readonly TodoItem[], title = 'Current todo list:'): string {
  if (todos.length === 0) {
    return 'Todo list is empty.';
  }
  const report = computeTodoProgress(todos);
  const childrenOf = new Map<string, TodoItem[]>();
  const known = new Set(todos.map((todo) => todo.id));
  for (const todo of todos) {
    if (todo.parentId === null || !known.has(todo.parentId)) continue;
    const list = childrenOf.get(todo.parentId) ?? [];
    list.push(todo);
    childrenOf.set(todo.parentId, list);
  }
  const lines: string[] = [
    `${title} (overall ${report.done}/${report.total} · ${report.overall}%)`,
  ];
  const roots = todos.filter((todo) => todo.parentId === null || !known.has(todo.parentId));
  for (const root of roots) {
    renderTreeLine(root, childrenOf, report.byId, 0, lines);
  }
  return lines.join('\n');
}

function renderTreeLine(
  item: TodoItem,
  childrenOf: ReadonlyMap<string, readonly TodoItem[]>,
  byId: ReadonlyMap<string, number>,
  depth: number,
  lines: string[],
): void {
  const indent = '  '.repeat(depth + 1);
  const progress = byId.get(item.id) ?? 0;
  const status = effectiveStatus(item, progress);
  const suffix = progressSuffix(item, childrenOf, progress);
  lines.push(`${indent}${statusMarker(status)} ${item.id}: ${item.title}${suffix}`);
  for (const child of childrenOf.get(item.id) ?? []) {
    renderTreeLine(child, childrenOf, byId, depth + 1, lines);
  }
}

function effectiveStatus(item: TodoItem, progress: number): TodoStatus {
  if (item.kind !== 'milestone') return item.status;
  if (progress >= 100) return 'done';
  if (progress > 0) return 'in_progress';
  return 'pending';
}

function progressSuffix(
  item: TodoItem,
  childrenOf: ReadonlyMap<string, readonly TodoItem[]>,
  progress: number,
): string {
  if (item.kind === 'milestone') {
    const children = childrenOf.get(item.id) ?? [];
    const done = children.filter((child) => child.status === 'done').length;
    return ` (${done}/${children.length} · ${progress}%)`;
  }
  if (item.status === 'done') return '';
  return progress > 0 ? ` (${progress}%)` : '';
}

function statusMarker(status: TodoStatus): string {
  switch (status) {
    case 'pending':
      return '[pending]';
    case 'in_progress':
      return '[in_progress]';
    case 'done':
      return '[done]';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
