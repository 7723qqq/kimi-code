import type { Component } from '@moonshot-ai/pi-tui';

import { getLocale, t } from '#/i18n';
import { transcriptGroupingActive, type TranscriptPresentationOptions } from '#/tui/config';
import { combineOutcomes, formatDuration } from '#/tui/utils/transcript-items';
import type {
  LogicalTranscriptItem,
  SummaryEvent,
  TranscriptItem,
} from '#/tui/utils/transcript-items';

export interface SingleProjection {
  readonly kind: 'single';
  readonly item: TranscriptItem;
}

export interface GroupProjection {
  readonly kind: 'group';
  readonly anchor: Component;
  readonly sourceIndex: number;
  readonly members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]];
  readonly external: readonly LogicalTranscriptItem[];
  readonly running: boolean;
}

export type TranscriptProjection = SingleProjection | GroupProjection;

export function projectTranscript(
  items: readonly TranscriptItem[],
  options: TranscriptPresentationOptions,
  isOpened: (component: Component) => boolean = () => false,
): readonly TranscriptProjection[] {
  if (!transcriptGroupingActive(options)) {
    return items.map((item) => ({ kind: 'single', item }));
  }
  const projections: TranscriptProjection[] = [];
  let run: LogicalTranscriptItem[] = [];
  const flush = (): void => {
    const first = run[0];
    if (first === undefined) return;
    const external = run.filter((item) => item.current && item.family === 'thinking');
    const externalSet = new Set(external);
    const members = run.filter((item) => !externalSet.has(item));
    const hasSummaryFragment = members.some(
      (item) => item.family === 'thinking' || item.event.kind !== 'silent',
    );
    if (members.length > 0 && hasSummaryFragment) {
      projections.push({
        kind: 'group',
        anchor: first.source,
        sourceIndex: first.sourceIndex,
        members: members as [LogicalTranscriptItem, ...LogicalTranscriptItem[]],
        external,
        running: members.some((member) => member.current),
      });
    } else {
      for (const item of run) projections.push({ kind: 'single', item });
    }
    run = [];
  };

  for (const item of items) {
    if (item.kind === 'transparent') continue;
    if (item.kind === 'logical' && canFoldItem(item, options) && !isOpened(item.display)) {
      run.push(item);
      continue;
    }
    flush();
    projections.push({ kind: 'single', item });
  }
  flush();
  return projections;
}

export function canFoldItem(
  item: LogicalTranscriptItem,
  options: TranscriptPresentationOptions,
): boolean {
  if (item.foldClass === 'thinking') return options.groupThinking;
  if (item.foldClass === 'explore') return options.groupTools !== 'off';
  return options.groupTools === 'auto';
}

export interface GroupSummary {
  readonly fragments: readonly string[];
  readonly added: number;
  readonly removed: number;
  readonly failed: number;
  readonly interrupted: number;
  readonly allFailed: boolean;
}

export function summarizeGroup(
  members: readonly [LogicalTranscriptItem, ...LogicalTranscriptItem[]],
): GroupSummary {
  const events = members.map((member) => member.event);
  const running = new Set(members.filter((member) => member.current).map((member) => member.event.kind));
  const key = 'tui.messages.transcriptGroups.summary';
  const count = (base: string, n: number): string =>
    t(`${key}.${base}_${n === 1 ? 'one' : 'other'}`, { count: n });
  const verb = (kind: SummaryEvent['kind'], past: string, present: string): string =>
    running.has(kind) ? present : past;
  const fragments: string[] = [];
  const thought = events.filter((event) => event.kind === 'thought');
  if (thought.length > 0) fragments.push(formatThought(thought, running.has('thought')));
  const readPaths = new Set(events.filter((event) => event.kind === 'read').map((event) => event.path));
  if (readPaths.size > 0) {
    fragments.push(count(verb('read', 'read', 'reading'), readPaths.size));
  }
  const searches = events.filter((event) => event.kind === 'search').length;
  if (searches > 0) fragments.push(count(verb('search', 'search', 'searching'), searches));
  const fetches = events.filter((event) => event.kind === 'fetch').length;
  if (fetches > 0) fragments.push(count(verb('fetch', 'fetch', 'fetching'), fetches));
  const webSearches = events.filter((event) => event.kind === 'webSearch').length;
  if (webSearches > 0) {
    fragments.push(count(verb('webSearch', 'webSearch', 'webSearching'), webSearches));
  }
  const skills = events.filter((event) => event.kind === 'skill').length;
  if (skills > 0) fragments.push(count(verb('skill', 'skill', 'loadingSkill'), skills));
  if (events.some((event) => event.kind === 'todo')) {
    fragments.push(t(`${key}.${verb('todo', 'todos', 'updatingTodos')}`));
  }
  const commands = events.filter((event) => event.kind === 'command').length;
  if (commands > 0) {
    fragments.push(count(verb('command', 'command', 'runningCommand'), commands));
  }
  const edits = events.filter((event) => event.kind === 'edit');
  const editPaths = new Set(edits.map((event) => event.path));
  if (editPaths.size > 0) fragments.push(count(verb('edit', 'edit', 'editing'), editPaths.size));
  const taskChecks = events.filter((event) => event.kind === 'taskCheck').length;
  if (taskChecks > 0) {
    fragments.push(count(verb('taskCheck', 'taskCheck', 'checkingTask'), taskChecks));
  }
  const mcpServers = new Map<string, number>();
  for (const event of events) {
    if (event.kind === 'mcp') mcpServers.set(event.server, (mcpServers.get(event.server) ?? 0) + 1);
  }
  for (const [server, calls] of mcpServers) {
    fragments.push(
      t(`${key}.${verb('mcp', 'mcp', 'callingMcp')}_${calls === 1 ? 'one' : 'other'}`, {
        server,
        count: calls,
      }),
    );
  }
  const otherTools = events.filter((event) => event.kind === 'query' || event.kind === 'other').length;
  if (otherTools > 0) {
    const present = running.has('query') || running.has('other');
    fragments.push(count(present ? 'usingTool' : 'tool', otherTools));
  }
  if (getLocale() === 'en') {
    const first = fragments[0];
    if (first !== undefined) fragments[0] = first.charAt(0).toUpperCase() + first.slice(1);
  }
  const landedEdits = edits.filter((event) => event.outcome.failed === 0 && event.outcome.interrupted === 0);
  const outcomes = events.flatMap((event) => 'outcome' in event ? [event.outcome] : []);
  const outcome = combineOutcomes(outcomes);
  return {
    fragments,
    added: landedEdits.reduce((total, event) => total + event.added, 0),
    removed: landedEdits.reduce((total, event) => total + event.removed, 0),
    failed: outcome.failed,
    interrupted: outcome.interrupted,
    allFailed: outcome.calls > 0 && outcome.failed === outcome.calls,
  };
}

function formatThought(
  events: readonly Extract<SummaryEvent, { kind: 'thought' }>[],
  running: boolean,
): string {
  const key = 'tui.messages.transcriptGroups.summary';
  if (running) return t(`${key}.thinking`);
  if (events.some((event) => event.durationMs === undefined)) return t(`${key}.thought`);
  const totalMs = events.reduce((total, event) => total + (event.durationMs ?? 0), 0);
  return t(`${key}.thoughtFor`, { duration: formatDuration(totalMs) });
}
