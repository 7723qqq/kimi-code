import { readFile as readFileTo, writeFile as writeFileTo } from 'node:fs/promises';

import type * as EngineModule from '@moonshot-ai/agent-core-v2';
import type { ISnapshotStore, SnapshotRecord } from '@moonshot-ai/agent-core-v2';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk/runtime';
import type { Command } from 'commander';
import { resolve } from 'pathe';

import { t } from '#/i18n';

type Engine = typeof EngineModule;

let enginePromise: Promise<Engine> | undefined;
function loadEngine(): Promise<Engine> {
  enginePromise ??= import('@moonshot-ai/agent-core-v2');
  return enginePromise;
}

interface WritableLike {
  write(chunk: string): boolean;
}

export interface SnapshotCommandDeps {
  readonly stdout: WritableLike;
  readonly stderr: WritableLike;
  readonly exit: (code: number) => never;
  readonly store: () => Promise<ISnapshotStore>;
  readonly resolvePath: (path: string) => string;
  readonly readFile: (path: string) => Promise<Uint8Array | undefined>;
  readonly writeFile: (path: string, bytes: Uint8Array) => Promise<void>;
}

function defaultDeps(): SnapshotCommandDeps {
  return {
    stdout: process.stdout,
    stderr: process.stderr,
    exit: (code: number) => process.exit(code),
    store: async () => {
      const engine = await loadEngine();
      return new engine.FileSnapshotStore(resolve(resolveKimiHome(), 'store', 'snapshots'));
    },
    resolvePath: (path: string) => resolve(path),
    readFile: async (path: string) => {
      try {
        return await readFileTo(path);
      } catch (error) {
        if ((error as { code?: unknown }).code === 'ENOENT') return undefined;
        throw error;
      }
    },
    writeFile: (path: string, bytes: Uint8Array) => writeFileTo(path, bytes),
  };
}

function writerRecord(
  records: readonly SnapshotRecord[],
  record: SnapshotRecord,
): SnapshotRecord | undefined {
  if (record.hash === '') return undefined;
  const index = records.indexOf(record);
  if (index < 0) return undefined;
  for (let cursor = index + 1; cursor < records.length; cursor += 1) {
    if (records[cursor]?.afterHash === record.hash) return records[cursor];
  }
  return undefined;
}

function writerOf(records: readonly SnapshotRecord[], index: number): string {
  const record = records[index];
  if (record === undefined) return 'unknown';
  return writerRecord(records, record)?.agentId ?? 'unknown';
}

function row(record: SnapshotRecord, writer: string): string {
  const skipped = record.skipped === undefined ? '' : ` skipped=${record.skipped}`;
  const hash = record.hash === '' ? '-' : record.hash.slice(0, 12);
  return `${record.at}  ${record.id.slice(-8)}  ${record.tool.padEnd(7)}  ${String(record.size).padStart(9)}B  destroyed-by=${record.agentId ?? '?'} content-from=${writer} session=${record.sessionId ?? '?'}${skipped}  ${hash}`;
}

interface ListOptions {
  readonly limit?: string;
}

interface RestoreOptions {
  readonly previous?: boolean;
  readonly hash?: string;
}

interface PruneOptions {
  readonly maxPerPath?: string;
  readonly maxAgeDays?: string;
}

type SnapshotAction = () => Promise<number>;

function numberAtLeast(
  raw: string | undefined,
  fallback: string,
  minimum: number,
  option: string,
  integer: boolean,
): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value) || value < minimum || (integer && !Number.isInteger(value))) {
    throw new Error(t('cli.snapshot.invalidNumber', { option, minimum: String(minimum) }));
  }
  return value;
}

export function registerSnapshotCommand(
  parent: Command,
  deps?: Partial<SnapshotCommandDeps>,
): void {
  const resolved: SnapshotCommandDeps = { ...defaultDeps(), ...deps };

  const run = async (action: SnapshotAction): Promise<void> => {
    let code: number;
    try {
      code = await action();
    } catch (error) {
      resolved.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      code = 1;
    }
    if (code !== 0) resolved.exit(code);
  };

  const snapshot = parent.command('snapshot').description(t('cli.commandDescriptions.snapshot'));

  snapshot
    .command('list <path>')
    .description(t('cli.commandDescriptions.snapshotList'))
    .option('--limit <count>', t('cli.snapshot.limitOption'), '20')
    .action((path: string, options: ListOptions) =>
      run(async () => {
        const target = resolved.resolvePath(path);
        const records = await (await resolved.store()).list(target);
        if (records.length === 0) {
          resolved.stdout.write(`${t('cli.snapshot.empty', { path: target })}\n`);
          return 0;
        }
        const limit = numberAtLeast(options.limit, '20', 1, '--limit', true);
        for (const [index, record] of records.slice(0, limit).entries()) {
          resolved.stdout.write(`${row(record, writerOf(records, index))}\n`);
        }
        return 0;
      }),
    );

  snapshot
    .command('restore <path>')
    .description(t('cli.commandDescriptions.snapshotRestore'))
    .option('--previous', t('cli.snapshot.previousOption'))
    .option('--hash <value>', t('cli.snapshot.hashOption'))
    .action((path: string, options: RestoreOptions) =>
      run(async () => {
        if (options.previous !== true && options.hash === undefined) {
          resolved.stderr.write(`${t('cli.snapshot.needSelection')}\n`);
          return 1;
        }
        const engine = await loadEngine();
        const store = await resolved.store();
        const target = resolved.resolvePath(path);
        const records = await store.list(target);
        const record = engine.pickSnapshot(records, {
          ...(options.hash === undefined ? {} : { hash: options.hash }),
          ...(options.previous === true ? { previous: true } : {}),
        });
        if (record === undefined) {
          resolved.stderr.write(`${t('cli.snapshot.missing', { path: target })}\n`);
          return 1;
        }
        if (record.skipped !== undefined) {
          resolved.stderr.write(`${t('cli.snapshot.notCaptured', { reason: record.skipped })}\n`);
          return 1;
        }
        const bytes = await store.content(record.hash);
        if (bytes === undefined) {
          resolved.stderr.write(`${t('cli.snapshot.noContent')}\n`);
          return 1;
        }
        const writer = writerRecord(records, record);
        const current = await resolved.readFile(target);
        if (current !== undefined) {
          const replaced = await store.record({
            path: target,
            at: new Date(),
            tool: 'Restore',
            mode: 'overwrite',
            size: current.byteLength,
            bytes: current,
            agentId: 'cli',
          });
          await store.complete(target, replaced.id, {
            hash: record.hash,
            size: bytes.byteLength,
          });
        }
        await resolved.writeFile(target, bytes);
        resolved.stdout.write(`${t('cli.snapshot.restored', { path: target })}\n`);
        resolved.stdout.write(
          `${t('cli.snapshot.destroyedBy', {
            agent: record.agentId ?? '?',
            at: record.at,
            tool: record.tool,
          })}\n`,
        );
        resolved.stdout.write(
          `${
            writer === undefined
              ? t('cli.snapshot.writtenByUnknown')
              : t('cli.snapshot.writtenBy', {
                  agent: writer.agentId ?? '?',
                  at: writer.at,
                })
          }\n`,
        );
        resolved.stdout.write(
          `${t('cli.snapshot.content', {
            hash: record.hash,
            size: String(bytes.byteLength),
            id: record.id,
          })}\n`,
        );
        return 0;
      }),
    );

  snapshot
    .command('agents <session-id>')
    .description(t('cli.commandDescriptions.snapshotAgents'))
    .action((sessionId: string) =>
      run(async () => {
        const marks = await (await resolved.store()).agents(sessionId);
        if (marks.length === 0) {
          resolved.stdout.write(`${t('cli.snapshot.noAgents', { session: sessionId })}\n`);
          return 0;
        }
        for (const mark of marks) {
          const parent = mark.parentAgentId === undefined ? '' : ` parent=${mark.parentAgentId}`;
          const item = mark.swarmIndex === undefined ? '' : ` item=${String(mark.swarmIndex)}`;
          resolved.stdout.write(
            `${mark.at}  ${mark.agentId}  ${mark.profileName ?? '?'}${item}${parent}  cwd=${mark.cwd}\n`,
          );
        }
        return 0;
      }),
    );

  snapshot
    .command('prune')
    .description(t('cli.commandDescriptions.snapshotPrune'))
    .option('--max-per-path <count>', t('cli.snapshot.maxPerPathOption'))
    .option('--max-age-days <days>', t('cli.snapshot.maxAgeOption'))
    .action((options: PruneOptions) =>
      run(async () => {
        const engine = await loadEngine();
        const perPath = numberAtLeast(
          options.maxPerPath,
          String(engine.SNAPSHOT_PRUNE_MAX_PER_PATH),
          1,
          '--max-per-path',
          true,
        );
        const days = numberAtLeast(
          options.maxAgeDays,
          String(engine.SNAPSHOT_PRUNE_MAX_AGE_MS / 86_400_000),
          0,
          '--max-age-days',
          false,
        );
        const result = await (
          await resolved.store()
        ).prune({
          now: new Date(),
          maxPerPath: perPath,
          maxBytesPerPath: engine.SNAPSHOT_PRUNE_MAX_BYTES_PER_PATH,
          maxAgeMs: days * 86_400_000,
          minObjectAgeMs: engine.SNAPSHOT_PRUNE_MIN_OBJECT_AGE_MS,
        });
        resolved.stdout.write(
          `${t('cli.snapshot.pruned', {
            records: String(result.recordsRemoved),
            objects: String(result.objectsRemoved),
          })}\n`,
        );
        return 0;
      }),
    );
}
