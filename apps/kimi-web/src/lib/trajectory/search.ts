// Incremental full-text index for the trajectory ledger. Ported from
// deepseek-harness ui-trajectory trajectory-search-index.ts (MIT).

import type { TrajectoryRecord, TrajectoryTurnModel } from './records';

interface SearchEntry {
  readonly sources: readonly string[];
  readonly text: string;
}

function searchableJson(value: unknown): string {
  if (value === undefined) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

function sameSources(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function recordSources(
  turn: number | null,
  group: string,
  record: TrajectoryRecord,
): readonly string[] {
  return [
    turn === null ? 'between turns' : `turn ${turn}`,
    group,
    record.kind,
    record.kind === 'assistant' ? 'assistant' : '',
    record.text,
    record.inputDetail ?? '',
    record.outputDetail ?? '',
    record.thinkingDetail ?? '',
    record.result ?? '',
    record.callId ?? '',
    record.toolName ?? '',
    searchableJson(record.isError === true ? { isError: true } : null),
  ];
}

/** Session-view-local index rebuilt only when a record's sources change. */
export class TrajectorySearchIndex {
  private readonly entries = new Map<string, SearchEntry>();
  private turnsVersion: readonly TrajectoryTurnModel[] | undefined;

  /**
   * Synchronize with the current layout; re-indexes only changed records.
   * @returns whether the layout reference changed (new searchable set).
   */
  update(turns: readonly TrajectoryTurnModel[]): boolean {
    if (this.turnsVersion === turns) return false;
    this.turnsVersion = turns;
    const seen = new Set<string>();
    for (const turn of turns) {
      for (const group of turn.groups) {
        for (const record of group.records) {
          if (record.requestOnly === true) continue;
          const id = record.id;
          const sources = recordSources(turn.turn, group.title, record);
          const previous = this.entries.get(id);
          const entry = previous !== undefined && sameSources(previous.sources, sources)
            ? previous
            : {
                sources,
                text: sources.join('\n').toLocaleLowerCase(),
              };
          this.entries.set(id, entry);
          seen.add(id);
        }
      }
    }
    for (const id of this.entries.keys()) {
      if (!seen.has(id)) this.entries.delete(id);
    }
    return true;
  }

  /**
   * Match a space-separated case-insensitive query; null when no query.
   */
  search(query: string): ReadonlySet<string> | null {
    const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return null;
    const matches = new Set<string>();
    for (const [id, entry] of this.entries) {
      if (terms.every((term) => entry.text.includes(term))) matches.add(id);
    }
    return matches;
  }
}
