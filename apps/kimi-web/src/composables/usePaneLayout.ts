import { ref } from 'vue';
import type { PaneKey } from '../types';

export type PaneGroup = {
  type: 'group';
  id: string;
  views: PaneKey[];
  active: PaneKey;
};

export type PaneSplit = {
  type: 'split';
  id: string;
  dir: 'row' | 'col';
  children: PaneLayout[];
  sizes: number[];
};

export type PaneLayout = PaneGroup | PaneSplit;

const STORAGE_KEY = 'kimi-web.layout';
const ALL_VIEWS: PaneKey[] = ['chat', 'files', 'tasks', 'todo', 'terminal'];

function nextId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function defaultGroup(active: PaneKey = 'chat'): PaneGroup {
  return { type: 'group', id: nextId('group'), views: [...ALL_VIEWS], active };
}

function isPaneKey(value: unknown): value is PaneKey {
  return value === 'chat' || value === 'files' || value === 'tasks' || value === 'todo' || value === 'terminal';
}

function normalizeLayout(raw: unknown): PaneLayout | null {
  if (!raw || typeof raw !== 'object') return null;
  const node = raw as Record<string, unknown>;
  if (node['type'] === 'group') {
    const active = isPaneKey(node['active']) ? node['active'] : 'chat';
    const views = Array.isArray(node['views'])
      ? node['views'].filter(isPaneKey)
      : ALL_VIEWS;
    return {
      type: 'group',
      id: typeof node['id'] === 'string' ? node['id'] : nextId('group'),
      views: views.length > 0 ? [...new Set(views)] : [...ALL_VIEWS],
      active,
    };
  }
  if (node['type'] === 'split') {
    const children = Array.isArray(node['children'])
      ? node['children'].map(normalizeLayout).filter((item): item is PaneLayout => item !== null)
      : [];
    if (children.length === 0) return null;
    const sizes = Array.isArray(node['sizes']) && node['sizes'].length === children.length
      ? node['sizes'].map((size) => typeof size === 'number' && Number.isFinite(size) ? size : 1)
      : children.map(() => 1);
    return {
      type: 'split',
      id: typeof node['id'] === 'string' ? node['id'] : nextId('split'),
      dir: node['dir'] === 'col' ? 'col' : 'row',
      children,
      sizes,
    };
  }
  return null;
}

function loadLayout(): PaneLayout {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalizeLayout(JSON.parse(raw)) ?? defaultGroup();
  } catch {
    // ignore
  }
  return defaultGroup();
}

function saveLayout(layout: PaneLayout): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  } catch {
    // ignore
  }
}

function updateGroup(layout: PaneLayout, groupId: string, fn: (group: PaneGroup) => PaneLayout): PaneLayout {
  if (layout.type === 'group') return layout.id === groupId ? fn(layout) : layout;
  return {
    ...layout,
    children: layout.children.map((child) => updateGroup(child, groupId, fn)),
  };
}

function removeGroup(layout: PaneLayout, groupId: string): PaneLayout {
  if (layout.type === 'group') return layout;
  const children = layout.children
    .filter((child) => child.type !== 'group' || child.id !== groupId)
    .map((child) => removeGroup(child, groupId));
  if (children.length === 1) return children[0]!;
  return {
    ...layout,
    children,
    sizes: children.map((_, index) => layout.sizes[index] ?? 1),
  };
}

function countGroups(layout: PaneLayout): number {
  if (layout.type === 'group') return 1;
  return layout.children.reduce((sum, child) => sum + countGroups(child), 0);
}

export function usePaneLayout() {
  const layout = ref<PaneLayout>(loadLayout());

  function commit(next: PaneLayout): void {
    layout.value = next;
    saveLayout(next);
  }

  function setActive(groupId: string, active: PaneKey): void {
    commit(updateGroup(layout.value, groupId, (group) => ({ ...group, active })));
  }

  function split(groupId: string, dir: 'row' | 'col'): void {
    commit(updateGroup(layout.value, groupId, (group) => ({
      type: 'split',
      id: nextId('split'),
      dir,
      children: [group, defaultGroup(group.active === 'terminal' ? 'chat' : 'terminal')],
      sizes: [1, 1],
    })));
  }

  function close(groupId: string): void {
    if (countGroups(layout.value) <= 1) return;
    commit(removeGroup(layout.value, groupId));
  }

  function resize(splitId: string, sizes: number[]): void {
    function visit(node: PaneLayout): PaneLayout {
      if (node.type === 'group') return node;
      if (node.id === splitId) return { ...node, sizes };
      return { ...node, children: node.children.map(visit) };
    }
    commit(visit(layout.value));
  }

  function reset(): void {
    commit(defaultGroup());
  }

  return { layout, setActive, split, close, resize, reset };
}
