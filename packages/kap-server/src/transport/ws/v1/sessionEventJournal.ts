import { createReadStream } from 'node:fs';
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ulid } from 'ulid';

const JOURNAL_VERSION = 1;

const MAX_PENDING_LINES = 4096;

export interface EventEnvelope {
  readonly type: string;
  readonly seq: number;
  readonly epoch?: string;
  readonly volatile?: boolean;
  readonly offset?: number;
  readonly session_id?: string;
  readonly timestamp: string;
  readonly payload: unknown;
}

interface JournalHeaderLine {
  kind: 'journal_header';
  version: number;
  epoch: string;
  created_at: number;
}

interface JournalEventLine {
  kind: 'event';
  seq: number;
  envelope: EventEnvelope;
}

export interface JournalEntry {
  seq: number;
  envelope: EventEnvelope;
}

export interface JournalLogger {
  warn(obj: unknown, msg: string): void;
  error?(obj: unknown, msg: string): void;
}

const noopLogger: JournalLogger = { warn: () => {} };

export class SessionEventJournal {
  private _seq: number;
  private pendingLines: string[] = [];
  private durabilityGapSeq: number | undefined;
  private headerWritten = false;
  private flushPromise: Promise<void> | undefined;
  private headerPending: boolean;
  private closed = false;

  private constructor(
    private readonly filePath: string,
    private readonly logger: JournalLogger,
    public readonly epoch: string,
    lastSeq: number,
    isFresh: boolean,
  ) {
    this._seq = lastSeq;
    this.headerPending = isFresh;
  }

  get seq(): number {
    return this._seq;
  }

  static async open(
    filePath: string,
    logger: JournalLogger = noopLogger,
  ): Promise<SessionEventJournal> {
    let epoch: string | undefined;
    let lastSeq = 0;
    let sawAnyLine = false;

    try {
      for await (const raw of readLines(filePath)) {
        sawAnyLine = true;
        const parsed = parseJournalLine(raw);
        if (parsed === undefined) continue;
        if (parsed.kind === 'journal_header') {
          if (epoch === undefined) epoch = parsed.epoch;
          continue;
        }
        if (parsed.seq > lastSeq) lastSeq = parsed.seq;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') {
        logger.warn(
          { filePath, err: String(error) },
          'event journal unreadable; starting a fresh epoch',
        );
      }
    }

    if (epoch === undefined) {
      if (sawAnyLine) {
        logger.warn({ filePath }, 'event journal missing header; rotating to a fresh epoch');
      }
      return new SessionEventJournal(filePath, logger, `ep_${ulid()}`, 0, true);
    }
    return new SessionEventJournal(filePath, logger, epoch, lastSeq, false);
  }

  nextSeq(): number {
    this._seq += 1;
    return this._seq;
  }

  append(seq: number, envelope: EventEnvelope): void {
    if (this.closed) return;
    const line: JournalEventLine = { kind: 'event', seq, envelope };
    this.pendingLines.push(JSON.stringify(line));
    this.scheduleFlush();
  }

  async readSince(fromSeqExclusive: number, limit: number): Promise<JournalEntry[]> {
    await this.flush();
    const out: JournalEntry[] = [];
    try {
      for await (const raw of readLines(this.filePath)) {
        const parsed = parseJournalLine(raw);
        if (parsed === undefined || parsed.kind !== 'event') continue;
        if (parsed.seq <= fromSeqExclusive) continue;
        out.push({ seq: parsed.seq, envelope: parsed.envelope });
        if (out.length >= limit) break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
    return out;
  }

  async flush(): Promise<void> {
    while (this.flushPromise !== undefined || this.pendingLines.length > 0) {
      if (this.flushPromise === undefined) {
        if (this.durabilityGapSeq !== undefined) return;
        this.flushPromise = this.flushOnce().finally(() => {
          this.flushPromise = undefined;
        });
      }
      await this.flushPromise;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.flush();
  }

  private scheduleFlush(): void {
    if (this.flushPromise !== undefined) return;
    this.flushPromise = this.flushOnce().finally(() => {
      this.flushPromise = undefined;
      if (this.pendingLines.length > 0 && this.durabilityGapSeq === undefined) {
        this.scheduleFlush();
      }
    });
  }

  private async flushOnce(): Promise<void> {
    const lines: string[] = [];
    let headerLine: string | undefined;
    if (this.headerPending) {
      const header: JournalHeaderLine = {
        kind: 'journal_header',
        version: JOURNAL_VERSION,
        epoch: this.epoch,
        created_at: Date.now(),
      };
      headerLine = JSON.stringify(header);
      lines.push(headerLine);
    }
    const batch = this.pendingLines.slice();
    lines.push(...batch);
    if (lines.length === 0) return;
    try {
      await mkdir(dirname(this.filePath), { recursive: true });
      await appendFile(this.filePath, lines.join('\n') + '\n', 'utf8');
      this.headerPending = false;
      this.pendingLines.splice(0, batch.length);
    } catch (error) {
      const firstSeq = firstSeqOf(batch);
      if (firstSeq !== undefined) {
        this.durabilityGapSeq =
          this.durabilityGapSeq === undefined
            ? firstSeq
            : Math.min(this.durabilityGapSeq, firstSeq);
        this.pendingLines = [...batch, ...this.pendingLines].slice(-MAX_PENDING_LINES);
      }
      this.logger.error?.(
        {
          filePath: this.filePath,
          err: String(error),
          seqFrom: firstSeq,
          seqTo: lastSeqOf(batch),
        },
        'event journal write failed; events remain live-only and cannot be replayed',
      );
    }
  }

  durabilityGapSince(): number | undefined {
    return this.durabilityGapSeq;
  }
}

export function sessionJournalPath(eventsDir: string, sessionId: string): string {
  return join(eventsDir, `${sessionId}.jsonl`);
}

function firstSeqOf(lines: readonly string[]): number | undefined {
  for (const raw of lines) {
    const parsed = parseJournalLine(raw);
    if (parsed !== undefined && parsed.kind === 'event') return parsed.seq;
  }
  return undefined;
}

function lastSeqOf(lines: readonly string[]): number | undefined {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const parsed = parseJournalLine(lines[i]!);
    if (parsed !== undefined && parsed.kind === 'event') return parsed.seq;
  }
  return undefined;
}

function parseJournalLine(raw: string): JournalHeaderLine | JournalEventLine | undefined {
  const trimmed = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (trimmed.length === 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null) return undefined;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === 'journal_header') {
    const epoch = (value as { epoch?: unknown }).epoch;
    if (typeof epoch !== 'string' || epoch.length === 0) return undefined;
    return value as JournalHeaderLine;
  }
  if (kind === 'event') {
    const seq = (value as { seq?: unknown }).seq;
    const envelope = (value as { envelope?: unknown }).envelope;
    if (typeof seq !== 'number' || !Number.isInteger(seq) || seq <= 0) return undefined;
    if (typeof envelope !== 'object' || envelope === null) return undefined;
    return value as JournalEventLine;
  }
  return undefined;
}

async function* readLines(filePath: string): AsyncIterable<string> {
  let buffered = '';
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  for await (const chunk of stream) {
    buffered += chunk;
    let newlineIndex = buffered.indexOf('\n');
    while (newlineIndex !== -1) {
      yield buffered.slice(0, newlineIndex);
      buffered = buffered.slice(newlineIndex + 1);
      newlineIndex = buffered.indexOf('\n');
    }
  }
  if (buffered.length > 0) yield buffered;
}
