// Trajectory overview timeline: projects ledger records into a stable
// three-lane domain (sequence / duration / time / actual), compresses idle
// gaps, and answers interval-focus queries. Ported from deepseek-harness
// ui-trajectory timeline.ts (MIT).

import type { TrajectoryRecord, TrajectoryTurnModel } from './records';

export type TrajectoryTimelineMode = 'sequence' | 'duration' | 'time' | 'actual';

export interface TrajectoryTimeRange {
  readonly start: number;
  readonly end: number;
}

export interface TrajectoryTimelineSpan extends TrajectoryTimeRange {
  readonly index: number;
  readonly isError: boolean;
  readonly kind: TrajectoryRecord['kind'];
  readonly label: string;
  readonly lane: number;
}

export interface TrajectoryTimelineTurnBoundary {
  readonly turn: number;
  readonly time: number;
}

export interface TrajectoryTimelineModel extends TrajectoryTimeRange {
  readonly spans: readonly TrajectoryTimelineSpan[];
  readonly turnBoundaries: readonly TrajectoryTimelineTurnBoundary[];
}

function laneFor(kind: TrajectoryRecord['kind']): number {
  if (kind === 'tool' || kind === 'subtool') return 2;
  if (kind === 'assistant' || kind === 'compacted') return 1;
  return 0;
}

function finite(value: number | null | undefined): value is number {
  return value !== null && value !== undefined && Number.isFinite(value);
}

function recordRange(record: TrajectoryRecord): TrajectoryTimeRange | null {
  if (!finite(record.startedAt)) return null;
  const durationMs = finite(record.timeSeconds)
    ? Math.max(0, record.timeSeconds * 1_000)
    : 0;
  return { start: record.startedAt, end: record.startedAt + durationMs };
}

function visibleRecords(turns: readonly TrajectoryTurnModel[]): TrajectoryRecord[] {
  return turns.flatMap((turn) =>
    turn.groups.flatMap((group) =>
      group.records.filter((record) => record.requestOnly !== true),
    ),
  );
}

/**
 * Project every visible record into the active timeline domain.
 * - sequence: one unit per record, in ledger order.
 * - duration: recorded durations with idle gaps compressed.
 * - time: recorded start times (idle gaps kept), zero width.
 * - actual: recorded start+duration (idle gaps kept).
 */
export function deriveTrajectoryTimeline(
  turns: readonly TrajectoryTurnModel[],
  mode: TrajectoryTimelineMode = 'sequence',
): TrajectoryTimelineModel | null {
  if (mode !== 'sequence') {
    return deriveTimedTimeline(
      turns,
      mode === 'duration' || mode === 'actual',
      mode === 'duration',
    );
  }

  const records = visibleRecords(turns);
  if (records.length === 0) return null;
  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const turn of turns) {
    const cells = turn.groups.flatMap((group) =>
      group.records.filter((record) => record.requestOnly !== true),
    );
    if (cells.length === 0) continue;
    if (turn.turn !== null) {
      turnBoundaries.push({ turn: turn.turn, time: spans.length });
    }
    for (const cell of cells) {
      spans.push({
        start: spans.length,
        end: spans.length + 1,
        index: cell.index,
        isError: cell.isError === true,
        kind: cell.kind,
        label: cell.text,
        lane: laneFor(cell.kind),
      });
    }
  }
  return { start: 0, end: spans.length, spans, turnBoundaries };
}

interface TimedTurn {
  readonly turn: number | null;
  readonly rawSpans: TrajectoryTimelineSpan[];
}

function deriveTimedTimeline(
  turns: readonly TrajectoryTurnModel[],
  actualDuration: boolean,
  compressIdle: boolean,
): TrajectoryTimelineModel | null {
  const timedTurns: TimedTurn[] = turns.flatMap((turn) => {
    const rawSpans = turn.groups.flatMap((group) =>
      group.records.flatMap((record): TrajectoryTimelineSpan[] => {
        if (record.requestOnly === true) return [];
        const range = recordRange(record);
        return range === null
          ? []
          : [{
              ...range,
              index: record.index,
              isError: record.isError === true,
              kind: record.kind,
              label: record.text,
              lane: laneFor(record.kind),
            }];
      }),
    );
    return rawSpans.length === 0 ? [] : [{ turn: turn.turn, rawSpans }];
  });
  const rawSpans = timedTurns.flatMap((turn) => turn.rawSpans);
  if (rawSpans.length === 0) return null;

  const removedIdleBySpan = new Map<TrajectoryTimelineSpan, number>();
  let removedIdle = 0;
  let coveredUntil: number | null = null;
  for (const span of [...rawSpans].toSorted(
    (left, right) => left.start - right.start || left.end - right.end,
  )) {
    if (compressIdle && coveredUntil !== null && span.start > coveredUntil) {
      removedIdle += span.start - coveredUntil;
    }
    removedIdleBySpan.set(span, removedIdle);
    coveredUntil =
      coveredUntil === null ? span.end : Math.max(coveredUntil, span.end);
  }

  const spans: TrajectoryTimelineSpan[] = [];
  const turnBoundaries: TrajectoryTimelineTurnBoundary[] = [];
  for (const turn of timedTurns) {
    const projected = turn.rawSpans.map((span): TrajectoryTimelineSpan => {
      const offset = removedIdleBySpan.get(span) ?? 0;
      return {
        ...span,
        start: span.start - offset,
        end: (actualDuration ? span.end : span.start) - offset,
      };
    });
    spans.push(...projected);
    if (turn.turn !== null) {
      turnBoundaries.push({
        turn: turn.turn,
        time: Math.min(...projected.map((span) => span.start)),
      });
    }
  }

  return {
    start: Math.min(...spans.map((span) => span.start)),
    end: Math.max(...spans.map((span) => span.end)),
    spans,
    turnBoundaries,
  };
}

/**
 * Identify records active at any point inside an inclusive selected interval.
 */
export function trajectoryTimelineFocusIndexes(
  turns: readonly TrajectoryTurnModel[],
  range: TrajectoryTimeRange,
  mode: TrajectoryTimelineMode = 'sequence',
): ReadonlySet<number> {
  const model = deriveTrajectoryTimeline(turns, mode);
  return new Set(
    model?.spans
      .filter((span) => span.start <= range.end && span.end >= range.start)
      .map((span) => span.index) ?? [],
  );
}

/** Format a timeline duration as an integer-millisecond label. */
export function formatTimelineOffset(milliseconds: number): string {
  return formatDurationMillis(milliseconds);
}

/** Duration label with thousands separators; em dash when unknown. */
export function formatDurationMillis(milliseconds: number | null): string {
  if (milliseconds === null || !Number.isFinite(milliseconds)) return '—';
  const integer = String(Math.round(milliseconds));
  return `${integer.replaceAll(/\B(?=(\d{3})+(?!\d))/, ',')} ms`;
}
