import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isRequestLogLine } from '#/claude-code';
import { writeAttachmentFile } from '#/images';
import type { ConversionIssue, EffectiveHistory, SessionSource, SourceCopy } from '#/types';

export async function saveEffectiveHistory(
  history: EffectiveHistory,
  directory: string,
  issues: readonly ConversionIssue[],
): Promise<string> {
  function* lines(): Generator<string> {
    const { turns, ...header } = history;
    yield JSON.stringify({ type: 'session', format: 'kimi-import-history', version: 1, ...header, issues }) + '\n';
    for (const turn of turns) yield JSON.stringify({ type: 'turn', ...turn }) + '\n';
  }
  const hash = new Bun.CryptoHasher('sha256');
  for (const line of lines()) hash.update(line);
  const filename = `effective-history-${hash.digest('hex')}.jsonl`;
  async function* chunks(): AsyncGenerator<Uint8Array> {
    for (const line of lines()) yield Buffer.from(line);
  }
  return (await writeAttachmentFile(directory, filename, chunks())).path;
}

function openSource(path: string): ReadableStream<Uint8Array> {
  const source = Bun.file(path).stream();
  return path.endsWith('.zst') ? source.pipeThrough(new DecompressionStream('zstd')) : source;
}

async function* keptLines(path: string, keep: (line: Buffer) => boolean): AsyncGenerator<Uint8Array> {
  let pending: Buffer[] = [];
  for await (const chunk of openSource(path)) {
    const buffer = Buffer.from(chunk);
    let start = 0;
    for (let end = buffer.indexOf(10); end >= 0; end = buffer.indexOf(10, start)) {
      pending.push(buffer.subarray(start, end + 1));
      const line = Buffer.concat(pending);
      pending = [];
      if (keep(line)) yield line;
      start = end + 1;
    }
    if (start < buffer.length) pending.push(buffer.subarray(start));
  }
  const tail = Buffer.concat(pending);
  if (tail.length > 0 && keep(tail)) yield tail;
}

async function copyFolder(source: string, destination: string, keep: (line: Buffer) => boolean): Promise<number> {
  let copied = 0;
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    const path = join(source, entry.name);
    if (entry.isDirectory()) copied += await copyFolder(path, join(destination, entry.name), keep);
    else if (entry.isFile()) {
      await writeAttachmentFile(destination, entry.name, entry.name.endsWith('.jsonl') ? keptLines(path, keep) : openSource(path));
      copied++;
    }
  }
  return copied;
}

export async function saveSourceCopy(source: SessionSource, sourcePath: string, attachmentDirectory: string, subagentPaths: readonly string[] = []): Promise<SourceCopy> {
  const directory = join(attachmentDirectory, 'source');
  const keep = source === 'claude-code' ? (line: Buffer) => !isRequestLogLine(line) : () => true;
  await writeAttachmentFile(directory, basename(sourcePath).replace(/\.zst$/, ''), keptLines(sourcePath, keep));
  const session = basename(sourcePath, '.jsonl');
  const folder = source === 'claude-code' && await copyFolder(join(dirname(sourcePath), session), join(directory, session), keep) > 0;
  for (const path of subagentPaths) await writeAttachmentFile(join(directory, 'subagents'), basename(path).replace(/\.zst$/, ''), keptLines(path, keep));
  return { directory, folder, subagentRollouts: subagentPaths.length };
}
