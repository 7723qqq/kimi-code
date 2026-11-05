import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fsp } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';

import { appendAudit, auditPath, readAudit, writeAudit } from '#/features/associativeMemory/audit';

describe('audit log', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(join(os.tmpdir(), 'associative-audit-'));
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  function path(): string {
    return auditPath(dir, 'associative-memory');
  }

  it('appends and reads back newest first', async () => {
    await appendAudit(path(), { at: 1, kind: 'write_blocked', detail: { rules: ['credential'] } });
    await appendAudit(path(), { at: 2, kind: 'pin', detail: { id: 'a1' } });
    const entries = await readAudit(path(), 10);
    expect(entries.map((entry) => entry.at)).toEqual([2, 1]);
    expect(entries[0]?.kind).toBe('pin');
  });

  it('returns empty when the log is missing', async () => {
    expect(await readAudit(path(), 10)).toEqual([]);
  });

  it('skips corrupt lines', async () => {
    await fsp.mkdir(join(dir, 'associative-memory'), { recursive: true });
    await fsp.writeFile(path(), 'not json\n{"at":3,"kind":"replay","detail":{}}\n', 'utf8');
    const entries = await readAudit(path(), 10);
    expect(entries.length).toBe(1);
    expect(entries[0]?.kind).toBe('replay');
  });

  it('honours the limit', async () => {
    for (let index = 0; index < 5; index++) {
      await appendAudit(path(), { at: index, kind: 'replay', detail: {} });
    }
    expect((await readAudit(path(), 2)).length).toBe(2);
  });

  it('round-trips through writeAudit', async () => {
    await writeAudit(path(), [{ at: 1, kind: 'replay', detail: {} }]);
    expect((await readAudit(path(), 5)).length).toBe(1);
  });
});
