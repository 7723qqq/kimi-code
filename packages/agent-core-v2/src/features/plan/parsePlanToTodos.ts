import type { TodoItem } from '#/features/todo/todoItem';

export function parsePlanToTodos(content: string): readonly TodoItem[] | null {
  const lines = content.split(/\r?\n/);
  const items: TodoItem[] = [];
  let currentMilestone: string | null = null;
  let nextMilestoneIndex = 1;
  let nextLeafIndex = 1;
  let sawAnyStructure = false;

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trim() === '') continue;

    const heading = parseHeading(line);
    if (heading !== null && (heading.level === 2 || heading.level === 3)) {
      const id = `M${nextMilestoneIndex++}`;
      currentMilestone = id;
      nextLeafIndex = 1;
      items.push({
        id,
        parentId: null,
        kind: 'milestone',
        title: heading.title.trim(),
        status: 'pending',
      });
      sawAnyStructure = true;
      continue;
    }

    if (currentMilestone === null) continue;

    const leaf = parseLeafItem(line);
    if (leaf === null) continue;
    const id = `${currentMilestone}.${nextLeafIndex++}`;
    items.push({
      id,
      parentId: currentMilestone,
      kind: 'task',
      title: leaf.title,
      status: leaf.status,
    });
    sawAnyStructure = true;
  }

  if (!sawAnyStructure || items.length === 0) return null;
  const hasMilestone = items.some((item) => item.kind === 'milestone');
  const hasLeaf = items.some((item) => item.kind === 'task');
  if (!hasMilestone || !hasLeaf) return null;
  return items;
}

interface HeadingMatch {
  readonly level: number;
  readonly title: string;
}

function parseHeading(line: string): HeadingMatch | null {
  const match = /^(#{2,3})\s+(.+?)\s*#*\s*$/.exec(line);
  if (match === null) return null;
  return { level: match[1]!.length, title: match[2]! };
}

interface LeafMatch {
  readonly title: string;
  readonly status: 'pending' | 'done';
}

function parseLeafItem(line: string): LeafMatch | null {
  const match = /^\s*(?:[-*]|\d+\.)\s+(\[[ xX]\]|\[ \])?\s*(.+?)\s*$/.exec(line);
  if (match === null) return null;
  const marker = match[1];
  const title = match[2]!.trim();
  if (title === '') return null;
  if (marker === '[x]' || marker === '[X]') return { title, status: 'done' };
  return { title, status: 'pending' };
}