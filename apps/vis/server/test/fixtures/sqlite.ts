// apps/vis/server/test/fixtures/sqlite.ts
//
// Build a temp engine home (sessions.db + agent_tasks.db) shaped exactly like
// the Rust engine writes them: sessions rows whose state_json is either a
// serialized `SessionRecord` (main) or `Agent::durable_state()` (subagent),
// flat `TaskInfoBase` JSON in task_records, nested-`base` background info in
// bg_task_records, chunked output, and decimal-ms cron timestamps.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DatabaseSync } from 'node:sqlite';

export interface SqliteFixture {
  home: string;
  cleanup: () => Promise<void>;
}

export async function buildSqliteFixture(): Promise<SqliteFixture> {
  const home = await mkdtemp(join(tmpdir(), 'vis-sqlite-fixture-'));
  try {
    const sessions = new DatabaseSync(join(home, 'sessions.db'));
    sessions.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        config_json TEXT NOT NULL DEFAULT '{}',
        state_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE records (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL,
        turn_id     TEXT NOT NULL,
        record_type TEXT NOT NULL,
        data_json   TEXT NOT NULL DEFAULT '{}',
        created_at  TEXT NOT NULL
      );
    `);
    sessions.prepare('INSERT INTO sessions (id, created_at, updated_at, config_json, state_json) VALUES (?, ?, ?, ?, ?)').run(
      'sess-main',
      '2026-01-01T00:00:00.000000Z',
      '2026-01-02T00:00:00.000000Z',
      JSON.stringify({ model: 'kimi-k2' }),
      JSON.stringify(mainSessionState()),
    );
    sessions.prepare('INSERT INTO sessions (id, created_at, updated_at, config_json, state_json) VALUES (?, ?, ?, ?, ?)').run(
      'sess-older',
      '2025-12-01T00:00:00.000000Z',
      '2025-12-02T00:00:00.000000Z',
      '{}',
      JSON.stringify({
        id: 'sess-older',
        created_at: '2025-12-01T00:00:00.000000Z',
        updated_at: '2025-12-02T00:00:00.000000Z',
        title: '',
        work_dir: '',
        model_config: { provider: 'kimi', model: 'kimi-k2' },
        messages: [],
        state: 'active',
        metadata: {},
      }),
    );
    sessions.prepare('INSERT INTO sessions (id, created_at, updated_at, config_json, state_json) VALUES (?, ?, ?, ?, ?)').run(
      'task-abc12345',
      '2026-01-01T00:00:00.000000Z',
      '2026-01-02T00:00:00.000000Z',
      '{}',
      JSON.stringify(subagentDurableState()),
    );
    // A row whose state_json is not JSON at all — treated as subagent.
    sessions.prepare('INSERT INTO sessions (id, created_at, updated_at, config_json, state_json) VALUES (?, ?, ?, ?, ?)').run(
      'task-corrupt0001',
      '2026-01-01T00:00:00.000000Z',
      '2026-01-02T00:00:00.000000Z',
      '{}',
      'not-json',
    );
    // Engine wire records for `sess-main` (stage-2 wire/context reader
    // fixture): one row per RECORD_TYPE_* dictionary entry, in the order the
    // engine writes them (turn → user/assistant messages → tool.call →
    // tool.result → tool message → usage → goal → compaction). The three
    // `message.append` rows mirror the state_json context list so the
    // snapshot and records-based projections agree. Other sessions have no
    // records (exercises the empty-records path).
    const records = sessions.prepare(
      'INSERT INTO records (session_id, turn_id, record_type, data_json, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    records.run('sess-main', 'turn-1', 'turn.started', '{"turn_id":"turn-1"}', '2026-01-01T00:00:01Z');
    records.run(
      'sess-main',
      'turn-1',
      'message.append',
      JSON.stringify({
        role: 'user',
        content: [{ type: 'text', text: 'hi' }],
        tool_calls: [],
        origin: { kind: 'user' },
      }),
      '2026-01-01T00:00:02Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'message.append',
      JSON.stringify({
        role: 'assistant',
        content: [{ type: 'text', text: 'ok' }],
        tool_calls: [
          { type: 'function', id: 'call_1', name: 'bash', arguments: { command: 'echo hi' } },
        ],
      }),
      '2026-01-01T00:00:03Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'tool.call',
      JSON.stringify({ tool_call_id: 'call_1', name: 'bash', input: { command: 'echo hi' } }),
      '2026-01-01T00:00:04Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'tool.result',
      JSON.stringify({ tool_call_id: 'call_1', name: 'bash', output: 'done', is_error: true }),
      '2026-01-01T00:00:05Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'message.append',
      JSON.stringify({
        role: 'tool',
        content: [{ type: 'text', text: 'done' }],
        tool_calls: [],
        tool_call_id: 'call_1',
        is_error: true,
      }),
      '2026-01-01T00:00:06Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'usage.updated',
      JSON.stringify({ model: 'kimi-k2', input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
      '2026-01-01T00:00:07Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'goal.updated',
      JSON.stringify({
        goalId: 'g-1',
        objective: 'fix the build',
        completionCriterion: 'tests green',
        status: 'active',
        turnsUsed: 3,
        tokensUsed: 100,
        wallClockMs: 5000,
        budget: { overBudget: false },
        terminalReason: null,
        blockedStreak: null,
        createdAt: 1_700_000_000_000,
        updatedAt: 1_700_000_100_000,
      }),
      '2026-01-01T00:00:08Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'compaction.started',
      JSON.stringify({ trigger: 'auto', tokens_before: 100 }),
      '2026-01-01T00:00:09Z',
    );
    records.run(
      'sess-main',
      'turn-1',
      'compaction.completed',
      JSON.stringify({ trigger: 'auto', tokens_before: 100, tokens_after: 50, summary: 'earlier turns summarised' }),
      '2026-01-01T00:00:10Z',
    );
    sessions.close();

    const tasks = new DatabaseSync(join(home, 'agent_tasks.db'));
    tasks.exec(`
      CREATE TABLE task_records (task_id TEXT PRIMARY KEY, info_json TEXT NOT NULL);
      CREATE TABLE task_output (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, chunk TEXT NOT NULL);
      CREATE TABLE bg_task_records (task_id TEXT PRIMARY KEY, info_json TEXT NOT NULL);
      CREATE TABLE bg_task_output (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, chunk TEXT NOT NULL);
      CREATE TABLE cron_tasks (
        id TEXT PRIMARY KEY,
        cron_expr TEXT NOT NULL,
        prompt TEXT NOT NULL,
        recurring INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        last_fired TEXT,
        next_fire TEXT
      );
    `);
    tasks.prepare('INSERT INTO task_records (task_id, info_json) VALUES (?, ?)').run(
      'bash-abc12345',
      JSON.stringify({
        task_id: 'bash-abc12345',
        description: 'run tests',
        status: 'completed',
        kind: 'process',
        started_at: 1_700_000_000_000,
        ended_at: 1_700_000_000_100,
        detached: false,
        terminal_notification_suppressed: false,
      }),
    );
    tasks.prepare('INSERT INTO task_output (task_id, chunk) VALUES (?, ?)').run('bash-abc12345', 'hello ');
    tasks.prepare('INSERT INTO task_output (task_id, chunk) VALUES (?, ?)').run('bash-abc12345', 'world');
    tasks.prepare('INSERT INTO bg_task_records (task_id, info_json) VALUES (?, ?)').run(
      'question-cdz1814n',
      JSON.stringify({
        base: {
          task_id: 'question-cdz1814n',
          description: 'Which auth?',
          status: 'completed',
          started_at: 1_785_743_399_616,
          ended_at: 1_785_743_399_623,
        },
        kind: 'question',
        question_count: 0,
      }),
    );
    tasks.prepare('INSERT INTO bg_task_records (task_id, info_json) VALUES (?, ?)').run(
      'bash-bbq1814n',
      JSON.stringify({
        base: {
          task_id: 'bash-bbq1814n',
          description: 'run server',
          status: 'failed',
          started_at: 1_785_743_400_000,
          ended_at: 1_785_743_401_000,
          detached: true,
        },
        kind: 'process',
        command: 'cargo run',
        pid: 4242,
        exit_code: 1,
      }),
    );
    tasks.prepare('INSERT INTO bg_task_output (task_id, chunk) VALUES (?, ?)').run(
      'bash-bbq1814n',
      'compiling…',
    );
    tasks
      .prepare(
        'INSERT INTO cron_tasks (id, cron_expr, prompt, recurring, created_at, last_fired, next_fire) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('cron-1', '0 9 * * *', 'morning report', 1, '1700000000000', '1700000100000', null);
    tasks
      .prepare(
        'INSERT INTO cron_tasks (id, cron_expr, prompt, recurring, created_at, last_fired, next_fire) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run('cron-2', '0 0 * * *', 'daily backup', 0, '1700000000001', null, null);
    tasks.close();
  } catch (error) {
    await rm(home, { recursive: true, force: true });
    throw error;
  }
  return {
    home,
    cleanup: async () => {
      await rm(home, { recursive: true, force: true });
    },
  };
}

/** Serialized `SessionRecord` shape for a main session. Optional fields the
 *  engine omits on write (null agent_state, empty metadata) are omitted to
 *  mirror real output. */
function mainSessionState(): Record<string, unknown> {
  return {
    id: 'sess-main',
    created_at: '2026-01-01T00:00:00.000000Z',
    updated_at: '2026-01-02T00:00:00.000000Z',
    title: 'hello sqlite',
    work_dir: 'C:/work',
    model_config: { provider: 'kimi', model: 'kimi-k2' },
    messages: [],
    state: 'active',
    agent_state: {
      goal: {
        goal_id: 'g-1',
        objective: 'fix the build',
        completion_criterion: 'tests green',
        status: 'active',
        turns_used: 3,
        tokens_used: 100,
        wall_clock_ms: 5000,
        budget_limits: {},
        created_at: 1_700_000_000_000,
        updated_at: 1_700_000_100_000,
      },
      context: [
        {
          role: 'user',
          content: [{ type: 'text', text: 'hi' }],
          tool_calls: [],
          origin: { kind: 'user' },
        },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'ok' }],
          tool_calls: [
            {
              type: 'function',
              id: 'call_1',
              name: 'bash',
              arguments: { command: 'echo hi' },
            },
          ],
        },
        {
          role: 'tool',
          content: [{ type: 'text', text: 'done' }],
          tool_calls: [],
          tool_call_id: 'call_1',
          is_error: true,
        },
      ],
      undo_checkpoints: [],
      turn_counter: 5,
      plan_active: true,
      plan_id: 'plan-1',
      token_count: 42,
      parent_tool_call_id: null,
      metadata: {},
    },
  };
}

/** `Agent::durable_state()` shape for a subagent row — no SessionRecord keys. */
function subagentDurableState(): Record<string, unknown> {
  return {
    goal: null,
    context: [
      {
        role: 'user',
        content: [{ type: 'text', text: 'sub prompt' }],
        tool_calls: [],
      },
    ],
    undo_checkpoints: [],
    turn_counter: 1,
    plan_active: false,
    token_count: 7,
    parent_tool_call_id: 'call_2',
    metadata: {},
  };
}
