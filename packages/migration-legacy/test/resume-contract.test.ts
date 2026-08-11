/**
 * End-to-end check that a migrated session lands in the exact on-disk layout
 * the session picker reads. The migrator writes session buckets named by
 * `computeWorkdirBucket`; the kimi-core session picker (`SessionStore.list`)
 * locates sessions purely by `readdir(encodeWorkDirKey(workDir))` (it never
 * consults `session_index.jsonl`). If the bucket algorithm diverges (see
 * review item C1), migrated sessions become silently invisible — this test
 * fails fast in that case.
 *
 * The v1-engine resume assertions were removed in P3a together with the
 * `@moonshot-ai/agent-core` dependency (the v1 engine is deleted in P4). The
 * checks below pin the data-level contract those resumes relied on:
 *   - `state.json` carries `custom.imported_from_kimi_cli` and
 *     `agents.main.homedir` pointing at `<sessionDir>/agents/main` — where
 *     `Session.resume()` reads `wire.jsonl` from. If `agents.main.homedir`
 *     pointed elsewhere (e.g. the project workdir), the resumed agent's
 *     context would be empty and the migrated history lost.
 *   - `agents/main/wire.jsonl` replays the translated history, including the
 *     recovered `toolCallDisplays` for legacy top-level ToolResults.
 * Re-introduce a real-engine resume check against agent-core-v2 once it has a
 * session-resume surface.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { encodeWorkDirKey, normalizeWorkDir } from '../src/v1-compat.js';
import { migrateOneSession, type MigrateOneResult } from '../src/sessions/migrate-one.js';
import { computeWorkdirBucket } from '../src/sessions/workdir-bucket.js';

const FIXTURES = fileURLToPath(new URL('./fixtures', import.meta.url));
const WORK_DIR = '/Users/example/proj';

let targetHome: string;
beforeEach(async () => {
  targetHome = await mkdtemp(join(tmpdir(), 'resume-contract-'));
});
afterEach(async () => {
  await rm(targetHome, { recursive: true, force: true });
});

/** Parse every non-empty line of a wire.jsonl into its record object. */
async function readWireRecords(sessionDir: string): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(join(sessionDir, 'agents', 'main', 'wire.jsonl'), 'utf-8');
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The migrated session directory the picker would find: `<home>/sessions/<bucket>/ses_<uuid>`. */
function pickerSessionDir(oldSessionUuid: string): string {
  return join(targetHome, 'sessions', computeWorkdirBucket(WORK_DIR), `ses_${oldSessionUuid}`);
}

describe('migrated session lands in the picker-visible layout', () => {
  it('computeWorkdirBucket stays byte-identical to the local encodeWorkDirKey', () => {
    // Both sides are the local v1-compat copy; this guards against a future
    // edit re-diverging computeWorkdirBucket from encodeWorkDirKey (the
    // picker's lookup is `readdir(encodeWorkDirKey(workDir))`).
    expect(computeWorkdirBucket(WORK_DIR)).toBe(
      encodeWorkDirKey(normalizeWorkDir(WORK_DIR)),
    );
  });

  it('migrated session is visible under the same workDir bucket', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'with-tool-calls'),
      oldSessionUuid: 'integ-uuid',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');

    // `SessionStore(homeDir)` resolves sessions under `homeDir/sessions`, and
    // `list()` does `readdir(encodeWorkDirKey(workDir))` — so the migrated
    // tree must be exactly `<home>/sessions/<bucket>/ses_<uuid>`. The session
    // id is the directory name (`ses_<uuid>`); `state.json` carries the
    // import marker the picker surfaces as metadata.
    const sessionDir = pickerSessionDir('integ-uuid');
    const state = JSON.parse(await readFile(join(sessionDir, 'state.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const custom = state['custom'] as Record<string, unknown>;
    expect(custom['imported_from_kimi_cli']).toBe(true);
  });

  it('migrated wire history is non-empty', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');

    const events = await readWireRecords(
      (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir,
    );
    expect(events[0]?.['type']).toBe('metadata');
    expect(events.filter((e) => e['type'] === 'context.append_message').length).toBeGreaterThan(
      0,
    );
  });

  it('agents.main.homedir points at the replayed wire history', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'tiny-hello-world'),
      oldSessionUuid: 'tiny-resume',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');
    const targetDir = (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir;

    // `Session.resume()` instantiates the main agent from
    // `agents.main.homedir` and replays *that directory's* `wire.jsonl`. If
    // `agents.main.homedir` were the project workdir (the bug), the agent
    // would replay an absent file and the history would be empty.
    const state = JSON.parse(await readFile(join(targetDir, 'state.json'), 'utf-8')) as Record<
      string,
      unknown
    >;
    const agents = state['agents'] as Record<string, unknown>;
    const main = agents['main'] as Record<string, unknown>;
    expect(main['homedir']).toBe(join(targetDir, 'agents', 'main'));

    const events = await readWireRecords(targetDir);
    const transcript = events
      .filter((e) => e['type'] === 'context.append_message')
      .flatMap((e) => {
        const message = e['message'] as Record<string, unknown>;
        const content = message['content'];
        return Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
      })
      .map((part) => (part['type'] === 'text' ? (part['text'] as string) : ''))
      .join('\n');
    expect(transcript).toContain('hi');
    expect(transcript).toContain('Hello! How can I help?');
  });

  it('wire replay preserves a legacy todo display', async () => {
    const result = await migrateOneSession({
      sourceSessionDir: join(FIXTURES, 'large-100msgs'),
      oldSessionUuid: 'todo-display',
      workdirPath: WORK_DIR,
      targetHome,
    });
    expect(result.outcome).toBe('migrated');

    // The resumed agent's `context.history` rebuilds from these records; the
    // display join (`extractToolCallDisplays`) must be present on the wire.
    const events = await readWireRecords(
      (result as Extract<MigrateOneResult, { outcome: 'migrated' }>).targetDir,
    );
    const assistant = events
      .filter((e) => e['type'] === 'context.append_message')
      .map((e) => e['message'] as Record<string, unknown>)
      .find((message) =>
        Array.isArray(message['toolCalls']) &&
        (message['toolCalls'] as Array<Record<string, unknown>>).some(
          (call) => call['id'] === 'tool_y3SXWWQIUysddnYoklaWhUeE',
        ),
      );
    expect(assistant).toBeDefined();

    const displays = assistant!['toolCallDisplays'] as Record<string, unknown>;
    expect(displays['tool_y3SXWWQIUysddnYoklaWhUeE']).toEqual({
      kind: 'todo_list',
      items: expect.arrayContaining([
        { title: '准备测试环境（创建隔离 work-dir）', status: 'in_progress' },
        { title: '汇报结论', status: 'pending' },
      ]),
    });
  });
});
