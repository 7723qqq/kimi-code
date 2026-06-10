// Local stub daemon for Kimi Web development.
//
// This is NOT the real backend. It is a throwaway dev server that speaks the
// daemon REST + WS wire protocol (envelope, snake_case, event frames) closely
// enough for the Web UI to be fully clickable before the real daemon exists.
// When the real daemon ships, point VITE_KIMI_DAEMON_HTTP_URL at it instead and
// stop running this.
//
//   node dev/stub-daemon.mjs            # listens on 127.0.0.1:7878
//   PORT=9000 node dev/stub-daemon.mjs
//
import http from 'node:http';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 7878;
const STARTED_AT = new Date().toISOString();

const now = () => new Date().toISOString();
const expires60 = () => new Date(Date.now() + 60_000).toISOString();

// Simple ULID-ish: time-prefix + random. Good enough for a stub.
function ulid(prefix = '') {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${t}${r}`;
}

const ok = (data) =>
  JSON.stringify({ code: 0, msg: 'success', data, request_id: ulid('req_') });
const fail = (code, msg, data = null) =>
  JSON.stringify({ code, msg, data, request_id: ulid('req_') });

// ---- PRESUMED: in-memory models + providers ----
// PRESUMED — not in current daemon docs; endpoints isolated here, swap when backend defines them.

const seedProviders = [
  {
    id: 'prov_moonshot',
    type: 'moonshot',
    base_url: undefined,
    default_model: 'moonshot-v1-128k',
    has_api_key: true,
    status: 'connected',
    models: ['moonshot-v1-128k', 'moonshot-v1-32k'],
  },
  {
    id: 'prov_anthropic',
    type: 'anthropic',
    base_url: undefined,
    default_model: undefined,
    has_api_key: false,
    status: 'unconfigured',
    models: [],
  },
  {
    id: 'prov_openai',
    type: 'openai',
    base_url: undefined,
    default_model: undefined,
    has_api_key: false,
    status: 'unconfigured',
    models: [],
  },
];

const seedModels = [
  { provider: 'prov_moonshot', model: 'moonshot-v1-128k', display_name: 'Moonshot 128K', max_context_size: 131072, capabilities: [] },
  { provider: 'prov_moonshot', model: 'moonshot-v1-32k', display_name: 'Moonshot 32K', max_context_size: 32768, capabilities: [] },
  { provider: 'prov_moonshot', model: 'moonshot-v1-8k', display_name: 'Moonshot 8K', max_context_size: 8192, capabilities: [] },
  { provider: 'prov_anthropic', model: 'claude-sonnet-4-6', display_name: 'Claude Sonnet 4.6', max_context_size: 200000, capabilities: ['thinking'] },
  { provider: 'prov_anthropic', model: 'claude-opus-4-5', display_name: 'Claude Opus 4.5', max_context_size: 200000, capabilities: ['thinking'] },
  { provider: 'prov_openai', model: 'gpt-4o', display_name: 'GPT-4o', max_context_size: 128000, capabilities: [] },
];

// Mutable arrays so POST/DELETE update them live
const providers = [...seedProviders];
const models = [...seedModels];

// ---- Real OAuth singleton state ----
let loggedIn = false;
let currentFlow = null; // { flow_id, provider, status, user_code, expires_in, interval, ... }

// ---- in-memory state ----

function mkUsage(ctx = 38000, turns = 2) {
  return {
    input_tokens: 1200 + ctx * 2,
    output_tokens: 600,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: +(ctx * 0.000002).toFixed(4),
    context_tokens: ctx,
    context_limit: 200000,
    turn_count: turns,
  };
}

function mkSession(id, title, status = 'idle', ctx = 38000, turns = 2) {
  return {
    id,
    title,
    created_at: now(),
    updated_at: now(),
    status,
    metadata: { cwd: '/Users/moonshot/code/kimi-code-web' },
    agent_config: { model: 'moonshot-v1-128k', tools: ['read', 'bash', 'edit', 'write'] },
    usage: mkUsage(ctx, turns),
    permission_rules: [],
    message_count: 0,
    last_seq: 0,
  };
}

// ---- seed sessions ----

const ses1 = mkSession('ses_1', '重构 API client 超时配置', 'idle', 52000, 4);
const ses2 = mkSession('ses_2', '修复 TUI 渲染抖动', 'idle', 29000, 2);
const ses3 = mkSession('ses_3', '登录态错误归一化', 'idle', 18000, 1);
const ses4 = mkSession('ses_4', '新功能：文件搜索高亮', 'idle', 8000, 0);

const sessions = [ses1, ses2, ses3, ses4];

// ---- seed workspaces + folder browser (demo) ----
// A wd_<slug>_<hash12> id, matching the real daemon's workspace id shape.
function wdId(root) {
  const slug = (root.split('/').filter(Boolean).pop() || 'root')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'root';
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) >>> 0;
  const hash = (h.toString(36) + '000000000000').slice(0, 12);
  return `wd_${slug}_${hash}`;
}

function mkWorkspace(root, name) {
  return {
    id: wdId(root),
    root,
    name: name || root.split('/').filter(Boolean).pop() || root,
    is_git_repo: true,
    branch: 'main',
    created_at: now(),
    last_opened_at: now(),
    session_count: sessions.filter((s) => s.metadata?.cwd === root).length,
  };
}

// Derive one workspace from the seeded session cwd, plus a couple of demo ones.
const workspaces = [
  mkWorkspace('/Users/moonshot/code/kimi-code-web', 'kimi-code-web'),
  mkWorkspace('/Users/moonshot/code/kimi-cli', 'kimi-cli'),
  mkWorkspace('/Users/moonshot/code/paseo', 'paseo'),
];

const FS_HOME = '/Users/moonshot';
const FS_RECENT = [
  '/Users/moonshot/code/kimi-code-web',
  '/Users/moonshot/code/kimi-cli',
];

// A tiny in-memory folder tree for the demo folder browser. Maps an absolute
// dir → its immediate subdirs (name + whether it's a git repo + branch).
const FS_TREE = {
  '/': [{ name: 'Users', git: false }],
  '/Users': [{ name: 'moonshot', git: false }],
  '/Users/moonshot': [
    { name: 'code', git: false },
    { name: 'Documents', git: false },
    { name: 'Downloads', git: false },
  ],
  '/Users/moonshot/code': [
    { name: 'kimi-code-web', git: true, branch: 'main' },
    { name: 'kimi-cli', git: true, branch: 'dev' },
    { name: 'paseo', git: true, branch: 'main' },
    { name: 'scratch', git: false },
  ],
  '/Users/moonshot/code/kimi-code-web': [
    { name: 'apps', git: false },
    { name: 'packages', git: false },
    { name: 'docs', git: false },
  ],
  '/Users/moonshot/code/kimi-cli': [{ name: 'src', git: false }],
  '/Users/moonshot/code/paseo': [{ name: 'src', git: false }],
};

function browseDir(dirPath) {
  const kids = FS_TREE[dirPath] || [];
  const parent = dirPath === '/' ? null : (dirPath.split('/').slice(0, -1).join('/') || '/');
  return {
    path: dirPath,
    parent,
    entries: kids.map((k) => ({
      name: k.name,
      path: dirPath === '/' ? `/${k.name}` : `${dirPath}/${k.name}`,
      is_dir: true,
      is_git_repo: !!k.git,
      ...(k.branch ? { branch: k.branch } : {}),
    })),
  };
}

// ---- seed messages ----

const t = (text) => ({ type: 'text', text });
const thinking = (text) => ({
  type: 'thinking',
  thinking: text,
  signature: 'sig_stub_' + Math.random().toString(36).slice(2, 8),
});
const toolUse = (id, name, input) => ({ type: 'tool_use', tool_call_id: id, tool_name: name, input });
const toolResult = (id, output, is_error = false) => ({
  type: 'tool_result',
  tool_call_id: id,
  output,
  is_error,
});

function mkMsg(id, session_id, role, content, prompt_id) {
  return { id, session_id, role, content, created_at: now(), prompt_id };
}

const messages = {
  ses_1: [
    mkMsg('msg_s1_1', 'ses_1', 'user', [t('把 api client 的超时改成可配置，然后跑测试')], 'pr_s1_1'),
    mkMsg('msg_s1_2', 'ses_1', 'assistant', [
      thinking(
        '用户想让我修改 API client，把硬编码的超时时间改成可通过参数配置的方式。\n' +
        '我需要先读取现有代码，了解超时目前是如何硬编码的，然后：\n' +
        '1. 修改 createClient 函数签名，加入 timeoutMs 可选参数\n' +
        '2. 更新相关测试\n让我先读一下文件。'
      ),
      t('好的，我先看一下 `api/client.ts` 的现有实现：'),
      toolUse('tc_s1_a', 'read', { path: 'packages/api/src/client.ts' }),
    ], 'pr_s1_1'),
    mkMsg('msg_s1_3', 'ses_1', 'assistant', [
      toolResult('tc_s1_a',
        'export function createClient(baseUrl: string) {\n' +
        '  const timeout = 30_000; // hardcoded\n' +
        '  return { baseUrl, timeout };\n' +
        '}\n', false),
    ], 'pr_s1_1'),
    mkMsg('msg_s1_4', 'ses_1', 'assistant', [
      t('找到了，超时是硬编码的 `30_000`。现在修改成可配置：'),
      toolUse('tc_s1_b', 'edit', {
        path: 'packages/api/src/client.ts',
        old_string: 'export function createClient(baseUrl: string) {\n  const timeout = 30_000; // hardcoded',
        new_string: 'export function createClient(baseUrl: string, timeoutMs = 30_000) {\n  const timeout = timeoutMs;',
      }),
    ], 'pr_s1_1'),
    mkMsg('msg_s1_5', 'ses_1', 'assistant', [
      toolResult('tc_s1_b', 'File edited successfully.', false),
      t('修改完成，现在跑测试确认没有回归：'),
      toolUse('tc_s1_c', 'bash', { command: 'pnpm --filter @kimi-code/api test --run' }),
    ], 'pr_s1_1'),
    mkMsg('msg_s1_6', 'ses_1', 'assistant', [
      toolResult('tc_s1_c',
        'PASS  packages/api/src/__tests__/client.test.ts\n' +
        'Test Suites: 1 passed, 1 total\nTests: 3 passed, 3 total\n', false),
    ], 'pr_s1_1'),
    mkMsg('msg_s1_7', 'ses_1', 'assistant', [
      t(
        '## 完成\n\n' +
        '**变更摘要**\n\n' +
        '- 给 `createClient` 加了 `timeoutMs` 可选参数，默认保持 `30_000` 不变\n' +
        '- 现有调用方无需修改（向后兼容）\n\n' +
        '所有 3 个测试通过，没有回归。'
      ),
    ], 'pr_s1_1'),
  ],

  ses_2: [
    mkMsg('msg_s2_1', 'ses_2', 'user', [t('TUI 偶尔抖动，看下渲染循环是否有问题')], 'pr_s2_1'),
    mkMsg('msg_s2_2', 'ses_2', 'assistant', [
      thinking(
        '用户报告 TUI 渲染抖动。可能原因：\n' +
        '1. 渲染节流不够导致频繁重绘\n' +
        '2. 状态更新与渲染循环冲突\n' +
        '先读渲染主循环。'
      ),
      t('先看一下 TUI 渲染循环的实现：'),
      toolUse('tc_s2_a', 'read', { path: 'apps/kimi-tui/src/renderer/loop.ts' }),
    ], 'pr_s2_1'),
    mkMsg('msg_s2_3', 'ses_2', 'assistant', [
      toolResult('tc_s2_a',
        'export class RenderLoop {\n' +
        '  private dirty = false;\n' +
        '  schedule() { this.dirty = true; this.flush(); }\n' +
        '  flush() { if (!this.dirty) return; this.dirty = false; this.render(); }\n' +
        '}\n', false),
    ], 'pr_s2_1'),
    mkMsg('msg_s2_4', 'ses_2', 'assistant', [
      t(
        '问题找到了。`schedule()` 在标记 `dirty` 之后立即 `flush()`，' +
        '所以同一帧内多次 `schedule()` 调用会触发多次 `render()`，造成抖动。\n\n' +
        '修复方案：用 `setImmediate` 把 flush 推迟到当前 tick 末尾。'
      ),
      toolUse('tc_s2_b', 'edit', {
        path: 'apps/kimi-tui/src/renderer/loop.ts',
        old_string: '  schedule() { this.dirty = true; this.flush(); }',
        new_string: '  schedule() { if (this.dirty) return; this.dirty = true; setImmediate(() => this.flush()); }',
      }),
    ], 'pr_s2_1'),
    mkMsg('msg_s2_5', 'ses_2', 'assistant', [
      toolResult('tc_s2_b', 'File edited successfully.', false),
      t('修复完成。现在 `schedule()` 在同一 tick 内只会排队一次 flush，消除了重复渲染。'),
    ], 'pr_s2_1'),
  ],

  ses_3: [
    mkMsg('msg_s3_1', 'ses_3', 'user', [t('登录态报错太乱了，帮我归一化一下错误处理')], 'pr_s3_1'),
    mkMsg('msg_s3_2', 'ses_3', 'assistant', [
      t('好的，我先搜索一下目前登录相关的错误处理分散在哪些文件：'),
      toolUse('tc_s3_a', 'bash', {
        command: 'rg "AuthError|loginError|auth_error" --type ts -l apps/kimi-cli/src/',
      }),
    ], 'pr_s3_1'),
    mkMsg('msg_s3_3', 'ses_3', 'assistant', [
      toolResult('tc_s3_a',
        'apps/kimi-cli/src/auth/login.ts\n' +
        'apps/kimi-cli/src/auth/refresh.ts\n' +
        'apps/kimi-cli/src/commands/auth.ts\n', false),
      t(
        '错误处理散落在 3 个文件里。建议统一到 `auth/errors.ts` 里定义一个 `AuthError` 类。\n\n' +
        '你希望我直接动手实施这个方案，还是先看看具体代码再决定？'
      ),
    ], 'pr_s3_1'),
  ],

  ses_4: [],
};

// Update message_count on sessions
for (const s of sessions) {
  s.message_count = (messages[s.id] || []).length;
}

// ---- seed tasks ----

const tasks = {
  ses_1: [
    {
      id: 'task_1', session_id: 'ses_1', kind: 'subagent', description: 'pnpm build --filter @kimi-code/api',
      status: 'running', created_at: now(), started_at: now(),
      output_preview: '$ pnpm build --filter @kimi-code/api\nvite v5.2.1 building for production...',
      output_bytes: 128,
    },
    {
      id: 'task_2', session_id: 'ses_1', kind: 'bash', description: 'eslint packages/api/src',
      status: 'running', created_at: now(), started_at: now(),
      output_preview: 'Running ESLint on packages/api/src...',
      output_bytes: 48,
    },
    {
      id: 'task_3', session_id: 'ses_1', kind: 'tool', description: 'Generate docs',
      status: 'completed', created_at: now(), started_at: now(), completed_at: now(),
      output_preview: 'Docs generated: docs/api/client.md\n0 errors, 0 warnings',
      output_bytes: 512,
    },
  ],
  ses_2: [],
  ses_3: [],
  ses_4: [],
};

// ---- sequence counters ----

const seqBySession = { ses_1: 8, ses_2: 5, ses_3: 2, ses_4: 0 };

// ---- pending continuations keyed by session_id ----
const pendingContinuation = {};
const pendingApproval = {};
const pendingQuestion = {};

// ---- WS broadcast ----

const sockets = new Set();

function broadcast(type, sessionId, payload) {
  const seq = (seqBySession[sessionId] = (seqBySession[sessionId] || 0) + 1);
  const session = sessions.find((s) => s.id === sessionId);
  if (session) session.last_seq = seq;
  const frame = JSON.stringify({ type, seq, session_id: sessionId, timestamp: now(), payload });
  for (const ws of sockets) if (ws.readyState === 1) ws.send(frame);
  return seq;
}

// ---- raw mode flag ----
// Set STUB_RAW_EVENTS=1 to emit raw agent-core events instead of projected event.* frames.
const RAW_EVENTS_MODE = process.env.STUB_RAW_EVENTS === '1';

// ---- scripted reply flows ----

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function streamMarkdown(sessionId, msgId, contentIndex, text, chunkSize = 40) {
  const chunks = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  for (const chunk of chunks) {
    await delay(80 + Math.random() * 60);
    broadcast('event.assistant.delta', sessionId, {
      message_id: msgId,
      content_index: contentIndex,
      delta: { text: chunk },
    });
  }
}

async function simulateToolUse(sessionId, parentMsgId, toolCallId, toolName, input, outputText) {
  broadcast('event.assistant.tool_use_started', sessionId, {
    message_id: parentMsgId,
    tool_call_id: toolCallId,
    tool_name: toolName,
    content_index: 1,
  });
  await delay(200);

  const inputStr = JSON.stringify(input);
  const chunkSize = 20;
  for (let i = 0; i < inputStr.length; i += chunkSize) {
    await delay(40);
    broadcast('event.assistant.tool_use_delta', sessionId, {
      message_id: parentMsgId,
      tool_call_id: toolCallId,
      input_delta: inputStr.slice(i, i + chunkSize),
    });
  }

  broadcast('event.assistant.tool_use_completed', sessionId, {
    message_id: parentMsgId,
    tool_call_id: toolCallId,
    input,
  });

  await delay(100);

  broadcast('event.tool.started', sessionId, {
    tool_call_id: toolCallId,
    tool_name: toolName,
    input,
    parent_message_id: parentMsgId,
  });

  const lines = outputText.split('\n');
  for (const line of lines) {
    await delay(50 + Math.random() * 80);
    broadcast('event.tool.output', sessionId, {
      tool_call_id: toolCallId,
      chunk: line + '\n',
      stream: 'stdout',
    });
  }

  await delay(100);
  broadcast('event.tool.completed', sessionId, {
    tool_call_id: toolCallId,
    output: outputText,
    is_error: false,
    duration_ms: 210 + Math.floor(Math.random() * 300),
  });
}

async function simulateDefaultReply(sessionId, userText) {
  const promptId = ulid('pr_');
  const session = sessions.find((s) => s.id === sessionId);

  broadcast('event.session.status_changed', sessionId, {
    status: 'running',
    previous_status: 'idle',
    current_prompt_id: promptId,
  });
  if (session) session.status = 'running';

  await delay(80);

  const userMsgId = ulid('msg_');
  const userMsg = mkMsg(userMsgId, sessionId, 'user', [t(userText)], promptId);
  (messages[sessionId] = messages[sessionId] || []).push(userMsg);
  broadcast('event.message.created', sessionId, { message: userMsg });

  await delay(150);

  const aMsgId = ulid('msg_');
  const aMsg = mkMsg(aMsgId, sessionId, 'assistant', [t('')], promptId);
  (messages[sessionId]).push(aMsg);
  broadcast('event.message.created', sessionId, { message: { ...aMsg, status: 'pending' } });

  await delay(300);

  const mdText =
    '## 分析结果\n\n' +
    '我检查了相关代码，发现以下问题：\n\n' +
    '- **超时配置** 目前硬编码在多处，应该统一到配置文件\n' +
    '- **重试逻辑** 缺少指数退避（exponential backoff）\n\n' +
    '我先读取 `src/api/client.ts` 确认当前实现：';

  await streamMarkdown(sessionId, aMsgId, 0, mdText);

  const readCallId = ulid('tc_');
  await simulateToolUse(
    sessionId, aMsgId, readCallId, 'read',
    { path: 'src/api/client.ts' },
    'import { fetch } from "node-fetch";\n\nconst TIMEOUT = 5000;\n\nexport async function apiGet(url) {\n  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });\n}\n'
  );

  await delay(200);

  const preWriteText = '\n\n找到了，超时硬编码为 `5000`。现在我来更新这个文件：';
  await streamMarkdown(sessionId, aMsgId, 0, preWriteText);

  await delay(200);

  const writeCallId = ulid('tc_');
  const approvalId = ulid('apv_');

  broadcast('event.assistant.tool_use_started', sessionId, {
    message_id: aMsgId,
    tool_call_id: writeCallId,
    tool_name: 'edit',
    content_index: 1,
  });
  broadcast('event.assistant.tool_use_completed', sessionId, {
    message_id: aMsgId,
    tool_call_id: writeCallId,
    input: {
      path: 'src/api/client.ts',
      old_string: 'const TIMEOUT = 5000;',
      new_string: 'const TIMEOUT = Number(process.env.API_TIMEOUT_MS ?? 5000);',
    },
  });

  await delay(150);

  broadcast('event.tool.started', sessionId, {
    tool_call_id: writeCallId,
    tool_name: 'edit',
    input: {
      path: 'src/api/client.ts',
      old_string: 'const TIMEOUT = 5000;',
      new_string: 'const TIMEOUT = Number(process.env.API_TIMEOUT_MS ?? 5000);',
    },
    parent_message_id: aMsgId,
  });

  await delay(100);

  broadcast('event.session.status_changed', sessionId, {
    status: 'awaiting_approval',
    previous_status: 'running',
    current_prompt_id: promptId,
  });
  if (session) session.status = 'awaiting_approval';

  broadcast('event.approval.requested', sessionId, {
    approval_id: approvalId,
    session_id: sessionId,
    tool_call_id: writeCallId,
    tool_name: 'edit',
    action: 'Edit file src/api/client.ts',
    display: {
      kind: 'diff',
      path: 'src/api/client.ts',
      old_text:
        'import { fetch } from "node-fetch";\n\nconst TIMEOUT = 5000;\n\nexport async function apiGet(url) {\n  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });\n}\n',
      new_text:
        'import { fetch } from "node-fetch";\n\nconst TIMEOUT = Number(process.env.API_TIMEOUT_MS ?? 5000);\n\nexport async function apiGet(url) {\n  return fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });\n}\n',
      summary: 'Replace hardcoded timeout with environment-variable-controlled value',
    },
    expires_at: expires60(),
    created_at: now(),
  });

  pendingApproval[sessionId] = approvalId;

  pendingContinuation[sessionId] = async () => {
    delete pendingContinuation[sessionId];
    delete pendingApproval[sessionId];

    broadcast('event.session.status_changed', sessionId, {
      status: 'running',
      previous_status: 'awaiting_approval',
      current_prompt_id: promptId,
    });
    if (session) session.status = 'running';

    await delay(100);

    broadcast('event.tool.completed', sessionId, {
      tool_call_id: writeCallId,
      output: 'File edited successfully.',
      is_error: false,
      duration_ms: 34,
    });

    const toolResultMsgId = ulid('msg_');
    const trMsg = mkMsg(toolResultMsgId, sessionId, 'assistant',
      [toolResult(writeCallId, 'File edited successfully.')], promptId);
    messages[sessionId].push(trMsg);
    broadcast('event.message.created', sessionId, { message: trMsg });

    await delay(200);

    const conclusionText =
      '\n\n文件已更新\n\n' +
      '现在 `TIMEOUT` 会读取 `API_TIMEOUT_MS` 环境变量，不设置时回退到默认值 `5000`。\n\n' +
      '需要我同时更新一下 `.env.example` 文件中的说明吗？';

    await streamMarkdown(sessionId, aMsgId, 0, conclusionText);

    await delay(100);

    broadcast('event.assistant.completed', sessionId, {
      message_id: aMsgId,
      finish_reason: 'stop',
    });

    const finalContent = [t(mdText + preWriteText + conclusionText)];
    broadcast('event.message.updated', sessionId, {
      message_id: aMsgId,
      content: finalContent,
      status: 'completed',
    });
    const aEntry = messages[sessionId].find((m) => m.id === aMsgId);
    if (aEntry) { aEntry.content = finalContent; aEntry.status = 'completed'; }

    await delay(100);

    const newCtx = (session?.usage?.context_tokens || 52000) + 8000;
    const newUsage = mkUsage(newCtx, (session?.usage?.turn_count || 0) + 1);
    if (session) session.usage = newUsage;
    broadcast('event.session.usage_updated', sessionId, {
      usage: newUsage,
      delta: {
        input_tokens: 2400,
        output_tokens: 800,
        cache_read_tokens: 400,
        cache_creation_tokens: 0,
        cost_usd: 0.0032,
      },
    });

    await delay(80);

    broadcast('event.session.status_changed', sessionId, {
      status: 'idle',
      previous_status: 'running',
    });
    if (session) session.status = 'idle';

    broadcastTaskProgress(sessionId);
  };
}

async function simulateQuestionReply(sessionId, userText) {
  const promptId = ulid('pr_');
  const session = sessions.find((s) => s.id === sessionId);

  broadcast('event.session.status_changed', sessionId, {
    status: 'running',
    previous_status: 'idle',
    current_prompt_id: promptId,
  });
  if (session) session.status = 'running';

  await delay(80);

  const userMsgId = ulid('msg_');
  const userMsg = mkMsg(userMsgId, sessionId, 'user', [t(userText)], promptId);
  (messages[sessionId] = messages[sessionId] || []).push(userMsg);
  broadcast('event.message.created', sessionId, { message: userMsg });

  await delay(200);

  const aMsgId = ulid('msg_');
  const aMsg = mkMsg(aMsgId, sessionId, 'assistant', [t('')], promptId);
  messages[sessionId].push(aMsg);
  broadcast('event.message.created', sessionId, { message: { ...aMsg, status: 'pending' } });

  await delay(250);
  await streamMarkdown(sessionId, aMsgId, 0, '在开始之前，我需要了解一下你的偏好：');

  await delay(200);

  const questionId = ulid('qst_');

  broadcast('event.session.status_changed', sessionId, {
    status: 'awaiting_question',
    previous_status: 'running',
    current_prompt_id: promptId,
  });
  if (session) session.status = 'awaiting_question';

  broadcast('event.question.requested', sessionId, {
    question_id: questionId,
    session_id: sessionId,
    questions: [
      {
        id: 'q_1',
        question: '你更倾向于哪种代码风格？',
        header: '代码风格',
        body: '影响注释、命名和函数长度等方面的偏好。',
        options: [
          { id: 'opt_1a', label: '简洁优先', description: '短函数、少注释、精炼命名' },
          { id: 'opt_1b', label: '可读性优先', description: '长注释、描述性命名、函数分层' },
          { id: 'opt_1c', label: '性能优先', description: '尽量减少抽象和开销' },
        ],
        multi_select: false,
        allow_other: false,
      },
      {
        id: 'q_2',
        question: '这次修改应该同时处理哪些子任务？',
        header: '范围选择',
        options: [
          { id: 'opt_2a', label: '更新单元测试' },
          { id: 'opt_2b', label: '更新文档注释' },
          { id: 'opt_2c', label: '更新 CHANGELOG' },
          { id: 'opt_2d', label: '更新 .env.example' },
        ],
        multi_select: true,
        allow_other: true,
        other_label: '其他',
        other_description: '如有特殊要求请填写',
      },
    ],
    expires_at: expires60(),
    created_at: now(),
  });

  pendingQuestion[sessionId] = questionId;

  pendingContinuation[sessionId] = async () => {
    delete pendingContinuation[sessionId];
    delete pendingQuestion[sessionId];

    broadcast('event.session.status_changed', sessionId, {
      status: 'running',
      previous_status: 'awaiting_question',
      current_prompt_id: promptId,
    });
    if (session) session.status = 'running';

    await delay(200);

    const replyText = '好的，已记录你的偏好，按照你的选择来实施修改。稍等……';
    await streamMarkdown(sessionId, aMsgId, 0, '\n\n' + replyText);

    await delay(100);

    broadcast('event.assistant.completed', sessionId, { message_id: aMsgId, finish_reason: 'stop' });
    broadcast('event.message.updated', sessionId, {
      message_id: aMsgId,
      content: [t(replyText)],
      status: 'completed',
    });

    await delay(100);

    const newCtx = (session?.usage?.context_tokens || 20000) + 3000;
    const newUsage = mkUsage(newCtx, (session?.usage?.turn_count || 0) + 1);
    if (session) session.usage = newUsage;
    broadcast('event.session.usage_updated', sessionId, {
      usage: newUsage,
      delta: { input_tokens: 800, output_tokens: 200, cache_read_tokens: 0, cache_creation_tokens: 0, cost_usd: 0.0008 },
    });

    await delay(80);

    broadcast('event.session.status_changed', sessionId, { status: 'idle', previous_status: 'running' });
    if (session) session.status = 'idle';
  };
}

function broadcastTaskProgress(sessionId) {
  const sessionTasks = (tasks[sessionId] || []).filter((t) => t.status === 'running');
  if (!sessionTasks.length) return;

  const intervals = [];

  for (const task of sessionTasks) {
    const lines = [
      'Building TypeScript sources...',
      'Resolving entry points...',
      'Bundling 42 modules...',
      'Emitting declaration files...',
      'Running post-build checks...',
      'Done.',
    ];
    let lineIdx = 0;

    const iv = setInterval(() => {
      if (lineIdx < lines.length) {
        broadcast('event.task.progress', sessionId, {
          task_id: task.id,
          output_chunk: lines[lineIdx] + '\n',
          stream: 'stdout',
        });
        lineIdx++;
      } else {
        clearInterval(iv);
        task.status = 'completed';
        task.completed_at = now();
        task.output_preview += '\nDone.';
        broadcast('event.task.completed', sessionId, {
          task_id: task.id,
          status: 'completed',
          output_preview: task.output_preview,
          output_bytes: (task.output_bytes || 0) + 64,
        });
      }
    }, 600);

    intervals.push(iv);
  }

  return intervals;
}

// ---- raw agent-core event simulation (STUB_RAW_EVENTS=1) ----
// Emits the real daemon's raw event shapes instead of projected event.* frames.
// This lets us verify the client-side agentEventProjector end-to-end.

function broadcastRaw(type, sessionId, payload) {
  const seq = (seqBySession[sessionId] = (seqBySession[sessionId] || 0) + 1);
  const session = sessions.find((s) => s.id === sessionId);
  if (session) session.last_seq = seq;
  const frame = JSON.stringify({ type, seq, session_id: sessionId, timestamp: now(), payload: { type, ...payload } });
  for (const ws of sockets) if (ws.readyState === 1) ws.send(frame);
  return seq;
}

async function simulateRawReply(sessionId, userText) {
  const session = sessions.find((s) => s.id === sessionId);
  const promptId = ulid('pr_');
  const turnId = Math.floor(Math.random() * 100000);

  // Store user message
  const userMsgId = ulid('msg_');
  const userMsg = mkMsg(userMsgId, sessionId, 'user', [{ type: 'text', text: userText }], promptId);
  (messages[sessionId] = messages[sessionId] || []).push(userMsg);

  await delay(80);

  // turn.started
  broadcastRaw('turn.started', sessionId, {
    turnId,
    origin: { kind: 'user' },
    agentId: 'main',
    sessionId,
  });

  await delay(100);

  // turn.step.started
  broadcastRaw('turn.step.started', sessionId, {
    turnId,
    step: 0,
    stepId: ulid('step_'),
    agentId: 'main',
    sessionId,
  });

  await delay(120);

  // thinking.delta
  const thinkingText = '分析用户输入：「' + userText + '」，准备回复。';
  for (let i = 0; i < thinkingText.length; i += 10) {
    await delay(40);
    broadcastRaw('thinking.delta', sessionId, {
      turnId,
      delta: thinkingText.slice(i, i + 10),
      agentId: 'main',
      sessionId,
    });
  }

  await delay(100);

  // assistant.delta — stream a reply in chunks
  const replyText =
    '你好！我是 Kimi，你的 AI 助手。\n\n' +
    '你发送了：**' + userText + '**\n\n' +
    '我已经收到你的消息，正在处理中。';

  const chunkSize = 8;
  for (let i = 0; i < replyText.length; i += chunkSize) {
    await delay(60 + Math.random() * 40);
    broadcastRaw('assistant.delta', sessionId, {
      turnId,
      delta: replyText.slice(i, i + chunkSize),
      agentId: 'main',
      sessionId,
    });
  }

  await delay(100);

  // turn.step.completed
  broadcastRaw('turn.step.completed', sessionId, {
    turnId,
    step: 0,
    stepId: ulid('step_'),
    usage: {
      inputOther: 1200,
      output: 80,
      inputCacheRead: 400,
      inputCacheCreation: 0,
    },
    finishReason: 'end_turn',
    agentId: 'main',
    sessionId,
  });

  await delay(80);

  // agent.status.updated
  const newCtx = (session?.usage?.context_tokens || 8000) + 2000;
  broadcastRaw('agent.status.updated', sessionId, {
    model: session?.agent_config?.model || 'moonshot-v1-128k',
    contextTokens: newCtx,
    maxContextTokens: 131072,
    contextUsage: newCtx / 131072,
    planMode: false,
    permission: 'auto',
    usage: {
      byModel: {},
      total: { inputOther: 1200, output: 80, inputCacheRead: 400, inputCacheCreation: 0 },
      currentTurn: { inputOther: 1200, output: 80, inputCacheRead: 400, inputCacheCreation: 0 },
    },
    agentId: 'main',
    sessionId,
  });
  if (session) session.usage.context_tokens = newCtx;

  await delay(80);

  // turn.ended
  broadcastRaw('turn.ended', sessionId, {
    turnId,
    reason: 'completed',
    agentId: 'main',
    sessionId,
  });

  await delay(50);

  // prompt.completed
  broadcastRaw('prompt.completed', sessionId, {
    agentId: 'main',
    sessionId,
    promptId,
  });

  if (session) session.status = 'idle';
}

function simulateReply(sessionId, userText) {
  if (RAW_EVENTS_MODE) {
    simulateRawReply(sessionId, userText).catch(console.error);
    return;
  }

  const lower = userText.toLowerCase();
  const isQuestion = lower.includes('问') || lower.includes('ask') || lower.includes('?') || lower.includes('？');

  if (isQuestion) {
    simulateQuestionReply(sessionId, userText).catch(console.error);
  } else {
    simulateDefaultReply(sessionId, userText).catch(console.error);
  }
}

// ---- REST ----

const server = http.createServer((req, res) => {
  const { url = '', method = 'GET' } = req;
  const path = url.split('?')[0];

  // Permissive CORS so a browser dev server on another port can read responses.
  res.setHeader('access-control-allow-origin', req.headers.origin || '*');
  res.setHeader('access-control-allow-methods', 'GET,POST,PATCH,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'content-type,x-request-id,authorization');
  res.setHeader('access-control-allow-credentials', 'true');
  res.setHeader('access-control-max-age', '86400');
  if (method === 'OPTIONS') { res.statusCode = 204; return res.end(); }
  res.setHeader('content-type', 'application/json; charset=utf-8');

  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const json = () => { try { return JSON.parse(body || '{}'); } catch { return {}; } };
    // Segments after stripping /api/v1 prefix
    // path: /api/v1/sessions/ses_1/messages → stripped: /sessions/ses_1/messages
    // We route on the stripped path for clarity.
    const isApiV1 = path.startsWith('/api/v1');
    const stripped = isApiV1 ? path.slice('/api/v1'.length) : path;
    const seg = stripped.split('/').filter(Boolean);
    // seg[0]: resource group (sessions, providers, models, auth, …)
    // seg[1]: first id
    // seg[2]: sub-resource or action
    const sid = seg[0] === 'sessions' ? seg[1] : undefined;

    // ---- healthz / meta ----
    if (stripped === '/healthz' || path === '/healthz') {
      return res.end(ok({ ok: true }));
    }
    if (stripped === '/meta' || path === '/meta') {
      return res.end(ok({
        daemon_version: '0.0.0-stub',
        capabilities: { websocket: true, file_upload: false, fs_query: false, mcp: false, background_tasks: true },
        server_id: 'stub',
        started_at: STARTED_AT,
      }));
    }

    // Require /api/v1 prefix for everything below
    if (!isApiV1) {
      return res.end(ok({}));
    }

    // ---- sessions collection ----
    if (stripped === '/sessions' && method === 'GET') {
      const sp = new URLSearchParams(url.split('?')[1] || '');
      const pageSize = Math.min(Number(sp.get('page_size') || '20'), 100);
      const status = sp.get('status');
      let items = [...sessions];
      if (status) items = items.filter((s) => s.status === status);
      items = items.slice(0, pageSize);
      return res.end(ok({ items, has_more: false }));
    }
    if (stripped === '/sessions' && method === 'POST') {
      const b = json();
      const s = mkSession(ulid('ses_'), b.title || '新会话', 'idle', 8000, 0);
      if (b.metadata) Object.assign(s.metadata, b.metadata);
      if (b.agent_config) Object.assign(s.agent_config, b.agent_config);
      sessions.unshift(s);
      messages[s.id] = [];
      tasks[s.id] = [];
      seqBySession[s.id] = 0;
      broadcast('event.session.created', s.id, { session: s });
      return res.end(ok(s));
    }

    // ---- sessions/{id} ----
    if (seg[0] === 'sessions' && sid && seg.length === 2) {
      const session = sessions.find((s) => s.id === sid);
      if (method === 'GET') {
        if (!session) return res.end(fail(40401, `session ${sid} does not exist`));
        return res.end(ok(session));
      }
      if (method === 'PATCH') {
        if (!session) return res.end(fail(40401, `session ${sid} does not exist`));
        const b = json();
        if (b.title !== undefined) session.title = b.title;
        if (b.metadata !== undefined) Object.assign(session.metadata, b.metadata);
        if (b.agent_config !== undefined) Object.assign(session.agent_config, b.agent_config);
        if (b.permission_rules !== undefined) session.permission_rules = b.permission_rules;
        session.updated_at = now();
        broadcast('event.session.updated', sid, { session, changed_fields: Object.keys(b) });
        return res.end(ok(session));
      }
      if (method === 'DELETE') {
        if (!session) return res.end(fail(40401, `session ${sid} does not exist`));
        const idx = sessions.findIndex((s) => s.id === sid);
        if (idx >= 0) sessions.splice(idx, 1);
        broadcast('event.session.deleted', sid, { session_id: sid });
        return res.end(ok({ deleted: true }));
      }
    }

    // ---- messages ----
    if (seg[0] === 'sessions' && seg[2] === 'messages' && seg.length === 3 && method === 'GET') {
      const sp = new URLSearchParams(url.split('?')[1] || '');
      const pageSize = Math.min(Number(sp.get('page_size') || '50'), 100);
      const items = (messages[sid] || []).slice(-pageSize);
      return res.end(ok({ items, has_more: false }));
    }
    if (seg[0] === 'sessions' && seg[2] === 'messages' && seg.length === 4 && method === 'GET') {
      const msgId = seg[3];
      const msg = (messages[sid] || []).find((m) => m.id === msgId);
      if (!msg) return res.end(fail(40403, `message ${msgId} does not exist`));
      return res.end(ok(msg));
    }

    // ---- tasks ----
    if (seg[0] === 'sessions' && seg[2] === 'tasks' && seg.length === 3 && method === 'GET') {
      const sp = new URLSearchParams(url.split('?')[1] || '');
      const status = sp.get('status');
      let items = tasks[sid] || [];
      if (status) items = items.filter((t) => t.status === status);
      return res.end(ok({ items }));
    }
    if (seg[0] === 'sessions' && seg[2] === 'tasks' && seg.length === 4 && method === 'GET') {
      const taskId = seg[3];
      const task = (tasks[sid] || []).find((t) => t.id === taskId);
      if (!task) return res.end(fail(40406, `task ${taskId} does not exist`));
      return res.end(ok(task));
    }
    if (seg[0] === 'sessions' && seg[2] === 'tasks' && seg.length === 4 && method === 'POST' && seg[3].endsWith(':cancel')) {
      const taskId = seg[3].replace(':cancel', '');
      const task = (tasks[sid] || []).find((t) => t.id === taskId);
      if (!task) return res.end(fail(40406, `task ${taskId} does not exist`));
      if (task.status !== 'running') return res.end(fail(40904, 'task already finished'));
      task.status = 'cancelled';
      task.completed_at = now();
      return res.end(ok({ cancelled: true }));
    }

    // ---- prompts ----
    if (seg[0] === 'sessions' && seg[2] === 'prompts' && seg.length === 3 && method === 'POST') {
      const b = json();
      const content = b.content || [];
      // Extract text from text-type parts only; tolerate image and other part types without crashing.
      const userText = content.filter((c) => c.type === 'text').map((c) => c.text).filter(Boolean).join('');
      const imageCount = content.filter((c) => c.type === 'image').length;
      const promptId = ulid('pr_');
      const userMsgId = ulid('msg_');
      const effectiveText = userText || (imageCount > 0 ? `[${imageCount} image(s) attached]` : '你好');
      setTimeout(() => simulateReply(sid, effectiveText), 100);
      return res.end(ok({ prompt_id: promptId, user_message_id: userMsgId, status: 'running' }));
    }
    // POST /sessions/{sid}/prompts:steer — steer queued prompts into the
    // active turn. The stub has no real queue: acknowledge so the web client's
    // submit→steer two-step can be exercised end-to-end.
    if (seg[0] === 'sessions' && seg[2] === 'prompts:steer' && seg.length === 3 && method === 'POST') {
      const b = json();
      const ids = Array.isArray(b.prompt_ids) ? b.prompt_ids : [];
      if (ids.length === 0) return res.end(fail(40001, 'prompt_ids required'));
      return res.end(ok({ steered: true, prompt_ids: ids }));
    }
    if (seg[0] === 'sessions' && seg[2] === 'prompts' && seg.length === 4 && method === 'POST' && seg[3].endsWith(':abort')) {
      return res.end(fail(40903, 'prompt already completed', { aborted: false }));
    }

    // ---- approvals ----
    if (seg[0] === 'sessions' && seg[2] === 'approvals' && seg.length === 4 && method === 'POST') {
      const approvalId = seg[3];
      const b = json();
      const resolvedAt = now();

      broadcast('event.approval.resolved', sid, {
        approval_id: approvalId,
        decision: b.decision || 'approved',
        scope: b.scope,
        feedback: b.feedback,
        resolved_by: 'user',
        resolved_at: resolvedAt,
      });

      if (pendingContinuation[sid]) {
        const cont = pendingContinuation[sid];
        setTimeout(() => cont(), 200);
      }

      return res.end(ok({ resolved: true, resolved_at: resolvedAt }));
    }

    // ---- questions ----
    if (seg[0] === 'sessions' && seg[2] === 'questions' && seg.length === 4 && method === 'POST') {
      const questionIdRaw = seg[3];

      if (questionIdRaw.endsWith(':dismiss')) {
        const questionId = questionIdRaw.replace(':dismiss', '');
        const dismissedAt = now();
        broadcast('event.question.dismissed', sid, {
          question_id: questionId,
          dismissed_by: 'user',
          dismissed_at: dismissedAt,
        });
        if (pendingContinuation[sid]) {
          const cont = pendingContinuation[sid];
          setTimeout(() => cont(), 200);
        }
        return res.end(fail(40909, 'question.dismissed', { dismissed: true, dismissed_at: dismissedAt }));
      }

      const questionId = questionIdRaw;
      const b = json();
      const resolvedAt = now();

      broadcast('event.question.answered', sid, {
        question_id: questionId,
        answers: b.answers || {},
        method: b.method,
        note: b.note,
        resolved_by: 'user',
        resolved_at: resolvedAt,
      });

      if (pendingContinuation[sid]) {
        const cont = pendingContinuation[sid];
        setTimeout(() => cont(), 200);
      }

      return res.end(ok({ resolved: true, resolved_at: resolvedAt }));
    }

    // ---- PRESUMED: models ----
    // PRESUMED — not in current daemon docs; swap when backend defines them.
    if (stripped === '/models' && method === 'GET') {
      return res.end(ok({ items: models }));
    }

    // ---- PRESUMED: providers ----
    // PRESUMED — not in current daemon docs; swap when backend defines them.
    if (stripped === '/providers' && method === 'GET') {
      return res.end(ok({ items: providers }));
    }
    if (stripped === '/providers' && method === 'POST') {
      const b = json();
      const newId = ulid('prov_');
      const newProv = {
        id: newId,
        type: b.type || 'custom',
        base_url: b.base_url || undefined,
        default_model: b.default_model || undefined,
        has_api_key: !!b.api_key,
        status: 'connected',
        models: [],
      };
      providers.push(newProv);
      models.push(
        { provider: newId, model: `${b.type || 'custom'}-default`, display_name: `${b.type || 'custom'} Default`, max_context_size: 128000, capabilities: [] },
      );
      newProv.models = [`${b.type || 'custom'}-default`];
      return res.end(ok(newProv));
    }
    if (seg[0] === 'providers' && seg.length === 2 && method === 'DELETE') {
      const provId = seg[1];
      const idx = providers.findIndex((p) => p.id === provId);
      if (idx < 0) return res.end(fail(40401, `provider ${provId} not found`));
      providers.splice(idx, 1);
      const toRemove = models.filter((m) => m.provider === provId);
      for (const m of toRemove) {
        const mi = models.indexOf(m);
        if (mi >= 0) models.splice(mi, 1);
      }
      return res.end(ok({ deleted: true }));
    }
    if (seg[0] === 'providers' && seg.length === 2 && method === 'POST' && seg[1].endsWith(':refresh')) {
      const provId = seg[1].replace(':refresh', '');
      const prov = providers.find((p) => p.id === provId);
      if (!prov) return res.end(fail(40401, `provider ${provId} not found`));
      prov.status = 'connected';
      return res.end(ok(prov));
    }

    // ---- workspaces + daemon folder browser (demo) ----
    // GET /api/v1/workspaces — derived from seeded session cwds + a couple demo
    // workspaces, each with a wd_<slug>_<hash12> id (matches the real shape).
    if (stripped === '/workspaces' && method === 'GET') {
      return res.end(ok({ items: workspaces }));
    }
    // POST /api/v1/workspaces { root, name? } — echo a wd_ workspace (idempotent per root)
    if (stripped === '/workspaces' && method === 'POST') {
      const b = json();
      const root = String(b.root || '').replace(/\/+$/, '') || '/';
      const existing = workspaces.find((w) => w.root === root);
      if (existing) return res.end(ok(existing));
      const ws = mkWorkspace(root, b.name);
      workspaces.unshift(ws);
      return res.end(ok(ws));
    }
    // PATCH /api/v1/workspaces/{id} { name }
    if (seg[0] === 'workspaces' && seg.length === 2 && method === 'PATCH') {
      const ws = workspaces.find((w) => w.id === seg[1]);
      if (!ws) return res.end(fail(40401, `workspace ${seg[1]} not found`));
      const b = json();
      if (b.name !== undefined) ws.name = b.name;
      return res.end(ok(ws));
    }
    // DELETE /api/v1/workspaces/{id} (registry only)
    if (seg[0] === 'workspaces' && seg.length === 2 && method === 'DELETE') {
      const idx = workspaces.findIndex((w) => w.id === seg[1]);
      if (idx < 0) return res.end(fail(40401, `workspace ${seg[1]} not found`));
      workspaces.splice(idx, 1);
      return res.end(ok({ deleted: true }));
    }

    // GET /api/v1/fs:home — picker start dir + recent roots
    if (stripped === '/fs:home' && method === 'GET') {
      return res.end(ok({ home: FS_HOME, recent_roots: FS_RECENT }));
    }
    // GET /api/v1/fs:browse?path=<abs> — subdirs only
    if (stripped === '/fs:browse' && method === 'GET') {
      const sp = new URLSearchParams(url.split('?')[1] || '');
      const reqPath = (sp.get('path') || FS_HOME).replace(/\/+$/, '') || '/';
      return res.end(ok(browseDir(reqPath)));
    }

    // ---- REAL auth endpoints ----

    // GET /api/v1/auth — readiness check
    if (stripped === '/auth' && method === 'GET') {
      return res.end(ok({
        ready: loggedIn,
        providers_count: loggedIn ? 1 : 0,
        default_model: loggedIn ? 'kimi-code/kimi-for-coding' : null,
        managed_provider: loggedIn ? { status: 'authenticated' } : null,
      }));
    }

    // POST /api/v1/oauth/login — start singleton device flow
    if (stripped === '/oauth/login' && method === 'POST') {
      const flowId = ulid('flow_');
      const userCode = 'DEMO-1234';
      const expiresIn = 1800;
      const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

      currentFlow = {
        flow_id: flowId,
        provider: 'managed:kimi-code',
        verification_uri: 'https://www.kimi.com/code/authorize_device',
        verification_uri_complete: `https://www.kimi.com/code/authorize_device?user_code=${userCode}`,
        user_code: userCode,
        expires_in: expiresIn,
        interval: 2,
        status: 'pending',
        expires_at: expiresAt,
      };

      // Auto-flip to 'authenticated' after 5 seconds
      const capturedFlowId = flowId;
      setTimeout(() => {
        if (currentFlow && currentFlow.flow_id === capturedFlowId && currentFlow.status === 'pending') {
          currentFlow.status = 'authenticated';
          currentFlow.resolved_at = now();
          loggedIn = true;
        }
      }, 5000);

      return res.end(ok({ ...currentFlow }));
    }

    // GET /api/v1/oauth/login — poll current singleton flow
    if (stripped === '/oauth/login' && method === 'GET') {
      return res.end(ok(currentFlow));
    }

    // DELETE /api/v1/oauth/login — cancel current flow
    if (stripped === '/oauth/login' && method === 'DELETE') {
      if (currentFlow) {
        currentFlow.status = 'cancelled';
        currentFlow.resolved_at = now();
      }
      const wasCancelled = currentFlow !== null;
      currentFlow = null;
      return res.end(ok({ cancelled: wasCancelled, status: 'cancelled' }));
    }

    // POST /api/v1/oauth/logout — logout
    if (stripped === '/oauth/logout' && method === 'POST') {
      loggedIn = false;
      currentFlow = null;
      return res.end(ok({ logged_out: true }));
    }

    // ---- fs:git_status ----
    // POST /api/v1/sessions/{id}/fs:git_status
    if (seg[0] === 'sessions' && seg[2] === 'fs:git_status' && seg.length === 3 && method === 'POST') {
      const session = sessions.find((s) => s.id === sid);
      if (!session) return res.end(fail(40401, `session ${sid} does not exist`));
      // Return realistic git status keyed by session
      const gitStatusBySid = {
        ses_1: {
          branch: 'feat/web',
          ahead: 1,
          behind: 0,
          entries: {
            'apps/kimi-code/package.json': 'modified',
            'packages/daemon/src/middleware/schema.ts': 'added',
            'apps/kimi-web/src/composables/useKimiWebClient.ts': 'modified',
          },
        },
        ses_2: {
          branch: 'fix/tui-render',
          ahead: 0,
          behind: 2,
          entries: {
            'apps/kimi-tui/src/renderer/loop.ts': 'modified',
          },
        },
        ses_3: {
          branch: 'refactor/auth-errors',
          ahead: 3,
          behind: 0,
          entries: {
            'apps/kimi-cli/src/auth/errors.ts': 'added',
            'apps/kimi-cli/src/auth/login.ts': 'modified',
            'apps/kimi-cli/src/auth/refresh.ts': 'modified',
            'apps/kimi-cli/src/commands/auth.ts': 'modified',
          },
        },
        ses_4: {
          branch: 'feat/file-search',
          ahead: 0,
          behind: 0,
          entries: {},
        },
      };
      const gs = gitStatusBySid[sid] ?? {
        branch: 'main',
        ahead: 0,
        behind: 0,
        entries: {},
      };
      return res.end(ok(gs));
    }

    // ---- fs:list ----
    // POST /api/v1/sessions/{id}/fs:list  body: { path, depth?, include_git_status? }
    if (seg[0] === 'sessions' && seg[2] === 'fs:list' && seg.length === 3 && method === 'POST') {
      const session = sessions.find((s) => s.id === sid);
      if (!session) return res.end(fail(40401, `session ${sid} does not exist`));
      const b = json();
      const reqPath = (b.path || '.').replace(/^\.\//, '').replace(/\/$/, '') || '.';

      const modifiedNow = now();

      // Nested stub filesystem tree
      const fsTree = {
        '.': [
          { path: 'src', name: 'src', kind: 'directory', modified_at: modifiedNow, etag: 'etag_src', child_count: 5 },
          { path: 'docs', name: 'docs', kind: 'directory', modified_at: modifiedNow, etag: 'etag_docs', child_count: 2 },
          { path: 'packages', name: 'packages', kind: 'directory', modified_at: modifiedNow, etag: 'etag_pkg', child_count: 3 },
          { path: 'package.json', name: 'package.json', kind: 'file', modified_at: modifiedNow, etag: 'etag_pkgjson', size: 892, mime: 'application/json', language_id: 'json' },
          { path: 'README.md', name: 'README.md', kind: 'file', modified_at: modifiedNow, etag: 'etag_readme', size: 1240, mime: 'text/markdown', language_id: 'markdown' },
          { path: 'tsconfig.json', name: 'tsconfig.json', kind: 'file', modified_at: modifiedNow, etag: 'etag_tsconfig', size: 320, mime: 'application/json', language_id: 'json' },
          { path: 'logo.png', name: 'logo.png', kind: 'file', modified_at: modifiedNow, etag: 'etag_logo', size: 68, mime: 'image/png', is_binary: true },
        ],
        'src': [
          { path: 'src/components', name: 'components', kind: 'directory', modified_at: modifiedNow, etag: 'etag_comp', child_count: 4 },
          { path: 'src/api', name: 'api', kind: 'directory', modified_at: modifiedNow, etag: 'etag_api', child_count: 2 },
          { path: 'src/main.ts', name: 'main.ts', kind: 'file', modified_at: modifiedNow, etag: 'etag_main', size: 420, mime: 'text/typescript', language_id: 'typescript' },
          { path: 'src/App.vue', name: 'App.vue', kind: 'file', modified_at: modifiedNow, etag: 'etag_app', size: 3200, mime: 'text/x-vue', language_id: 'vue' },
          { path: 'src/style.css', name: 'style.css', kind: 'file', modified_at: modifiedNow, etag: 'etag_style', size: 680, mime: 'text/css', language_id: 'css', git_status: 'modified' },
        ],
        'src/components': [
          { path: 'src/components/TabBar.vue', name: 'TabBar.vue', kind: 'file', modified_at: modifiedNow, etag: 'etag_tabbar', size: 1800, mime: 'text/x-vue', language_id: 'vue' },
          { path: 'src/components/FileTree.vue', name: 'FileTree.vue', kind: 'file', modified_at: modifiedNow, etag: 'etag_filetree', size: 4200, mime: 'text/x-vue', language_id: 'vue', git_status: 'added' },
          { path: 'src/components/FilePreview.vue', name: 'FilePreview.vue', kind: 'file', modified_at: modifiedNow, etag: 'etag_filepreview', size: 3900, mime: 'text/x-vue', language_id: 'vue', git_status: 'added' },
          { path: 'src/components/DiffView.vue', name: 'DiffView.vue', kind: 'file', modified_at: modifiedNow, etag: 'etag_diffview', size: 2800, mime: 'text/x-vue', language_id: 'vue' },
        ],
        'src/api': [
          { path: 'src/api/types.ts', name: 'types.ts', kind: 'file', modified_at: modifiedNow, etag: 'etag_types', size: 5200, mime: 'text/typescript', language_id: 'typescript' },
          { path: 'src/api/client.ts', name: 'client.ts', kind: 'file', modified_at: modifiedNow, etag: 'etag_client', size: 1800, mime: 'text/typescript', language_id: 'typescript', git_status: 'modified' },
        ],
        'docs': [
          { path: 'docs/api.md', name: 'api.md', kind: 'file', modified_at: modifiedNow, etag: 'etag_apidoc', size: 2400, mime: 'text/markdown', language_id: 'markdown', git_status: 'modified' },
          { path: 'docs/CHANGELOG.md', name: 'CHANGELOG.md', kind: 'file', modified_at: modifiedNow, etag: 'etag_changelog', size: 5600, mime: 'text/markdown', language_id: 'markdown' },
        ],
        'packages': [
          { path: 'packages/daemon', name: 'daemon', kind: 'directory', modified_at: modifiedNow, etag: 'etag_daemon', child_count: 8 },
          { path: 'packages/api', name: 'api', kind: 'directory', modified_at: modifiedNow, etag: 'etag_api_pkg', child_count: 5 },
          { path: 'packages/types', name: 'types', kind: 'directory', modified_at: modifiedNow, etag: 'etag_types_pkg', child_count: 3 },
        ],
        'packages/daemon': [
          { path: 'packages/daemon/src', name: 'src', kind: 'directory', modified_at: modifiedNow, etag: 'etag_dsrc', child_count: 6 },
          { path: 'packages/daemon/package.json', name: 'package.json', kind: 'file', modified_at: modifiedNow, etag: 'etag_dpkg', size: 640, mime: 'application/json', language_id: 'json' },
        ],
        'packages/api': [
          { path: 'packages/api/src', name: 'src', kind: 'directory', modified_at: modifiedNow, etag: 'etag_asrc', child_count: 3 },
          { path: 'packages/api/package.json', name: 'package.json', kind: 'file', modified_at: modifiedNow, etag: 'etag_apkg', size: 420, mime: 'application/json', language_id: 'json' },
        ],
      };

      const items = fsTree[reqPath] || [];
      return res.end(ok({ items, truncated: false }));
    }

    // ---- fs:read ----
    // POST /api/v1/sessions/{id}/fs:read  body: { path, offset?, length? }
    if (seg[0] === 'sessions' && seg[2] === 'fs:read' && seg.length === 3 && method === 'POST') {
      const session = sessions.find((s) => s.id === sid);
      if (!session) return res.end(fail(40401, `session ${sid} does not exist`));
      const b = json();
      const reqPath = b.path || 'README.md';

      // Tiny 1×1 transparent PNG (base64)
      const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

      const fileContents = {
        'README.md': {
          content:
            '# Kimi Code Web\n\n' +
            'A browser-based workspace client for the Kimi Code daemon.\n\n' +
            '## Features\n\n' +
            '- **~/chat** — Conversational AI interface with tool calls and approvals\n' +
            '- **~/diff** — Real-time git status and changed-file tracking\n' +
            '- **~/tasks** — Background task monitoring (subagents, bash, tools)\n' +
            '- **~/files** — Workspace file browser with lazy tree and preview\n\n' +
            '## Quick Start\n\n' +
            '```bash\n' +
            'pnpm install\n' +
            'pnpm -C apps/kimi-web run dev:stub  # start stub daemon\n' +
            'pnpm -C apps/kimi-web run dev        # start Vite dev server\n' +
            '```\n\n' +
            '## Architecture\n\n' +
            'The web client is a Vue 3 + TypeScript SPA. All daemon calls go through\n' +
            '`useKimiWebClient` composable, which owns the reactive state and exposes\n' +
            'typed action functions to components.\n\n' +
            '> **Note:** The stub daemon (`dev/stub-daemon.mjs`) speaks the real wire\n' +
            '> protocol closely enough for all UI features to be fully demoable.\n',
          encoding: 'utf-8',
          mime: 'text/markdown',
          language_id: 'markdown',
          size: 1240,
          line_count: 35,
          is_binary: false,
          etag: 'etag_readme',
          truncated: false,
        },
        'package.json': {
          content: JSON.stringify({
            name: '@moonshot-ai/kimi-web',
            version: '0.1.1',
            private: true,
            license: 'MIT',
            type: 'module',
            scripts: {
              dev: 'vite',
              'dev:stub': 'node dev/stub-daemon.mjs',
              build: 'vite build',
              typecheck: 'vue-tsc --noEmit',
              test: 'vitest run',
            },
            dependencies: { marked: '^14.1.4', vue: '^3.5.35' },
            devDependencies: {
              '@vitejs/plugin-vue': '^5.2.4',
              '@vue/test-utils': '^2.4.6',
              typescript: '6.0.2',
              vite: '^6.3.3',
              vitest: '^2.1.8',
            },
          }, null, 2),
          encoding: 'utf-8',
          mime: 'application/json',
          language_id: 'json',
          size: 892,
          line_count: 28,
          is_binary: false,
          etag: 'etag_pkgjson',
          truncated: false,
        },
        'tsconfig.json': {
          content: JSON.stringify({
            compilerOptions: {
              target: 'ES2022',
              module: 'ESNext',
              moduleResolution: 'bundler',
              strict: true,
              jsx: 'preserve',
              lib: ['ES2022', 'DOM'],
            },
            include: ['src/**/*'],
            exclude: ['node_modules'],
          }, null, 2),
          encoding: 'utf-8',
          mime: 'application/json',
          language_id: 'json',
          size: 320,
          line_count: 14,
          is_binary: false,
          etag: 'etag_tsconfig',
          truncated: false,
        },
        'src/api/client.ts': {
          content:
            '// src/api/client.ts\n' +
            '// Daemon HTTP + WS client — maps wire protocol to app types.\n\n' +
            'import type { KimiWebApi } from \'./types\';\n\n' +
            'const DEFAULT_TIMEOUT_MS = Number(process.env.API_TIMEOUT_MS ?? 30_000);\n\n' +
            'export function createApiClient(baseUrl: string, timeoutMs = DEFAULT_TIMEOUT_MS): KimiWebApi {\n' +
            '  // Implementation elided for brevity in the stub.\n' +
            '  return {} as KimiWebApi;\n' +
            '}\n',
          encoding: 'utf-8',
          mime: 'text/typescript',
          language_id: 'typescript',
          size: 1800,
          line_count: 11,
          is_binary: false,
          etag: 'etag_client',
          truncated: false,
        },
        'src/style.css': {
          content:
            '@import "tailwindcss";\n\n' +
            ':root {\n' +
            '  --ink: #14171c;\n' +
            '  --text: #3f454d;\n' +
            '  --dim: #697079;\n' +
            '  --muted: #8b929b;\n' +
            '  --line: #e7eaee;\n' +
            '  --panel: #fafbfc;\n' +
            '  --bg: #ffffff;\n' +
            '  --blue: #1565c0;\n' +
            '  --blue2: #0d4f9e;\n' +
            '  --soft: #e9f0fa;\n' +
            '  --mono: "SF Mono", ui-monospace, Menlo, Consolas, monospace;\n' +
            '}\n\n' +
            'body {\n' +
            '  font-family: var(--mono);\n' +
            '  color: var(--text);\n' +
            '  background: var(--bg);\n' +
            '  font-size: 12.5px;\n' +
            '  line-height: 1.55;\n' +
            '}\n',
          encoding: 'utf-8',
          mime: 'text/css',
          language_id: 'css',
          size: 680,
          line_count: 24,
          is_binary: false,
          etag: 'etag_style',
          truncated: false,
        },
        'docs/api.md': {
          content:
            '# API Reference\n\n' +
            '## File System Endpoints\n\n' +
            '### `POST /api/v1/sessions/{id}/fs:list`\n\n' +
            'List directory contents.\n\n' +
            '**Request body:**\n' +
            '```json\n' +
            '{ "path": "src", "include_git_status": true }\n' +
            '```\n\n' +
            '**Response:**\n' +
            '```json\n' +
            '{ "items": [...], "truncated": false }\n' +
            '```\n\n' +
            '### `POST /api/v1/sessions/{id}/fs:read`\n\n' +
            'Read file content.\n\n' +
            '**Request body:**\n' +
            '```json\n' +
            '{ "path": "README.md" }\n' +
            '```\n\n' +
            '**Response:**\n' +
            '```json\n' +
            '{ "content": "...", "encoding": "utf-8", "mime": "text/markdown", ... }\n' +
            '```\n',
          encoding: 'utf-8',
          mime: 'text/markdown',
          language_id: 'markdown',
          size: 2400,
          line_count: 42,
          is_binary: false,
          etag: 'etag_apidoc',
          truncated: false,
        },
        'logo.png': {
          content: PNG_1X1,
          encoding: 'base64',
          mime: 'image/png',
          size: 68,
          is_binary: true,
          etag: 'etag_logo',
          truncated: false,
        },
      };

      const fileData = fileContents[reqPath];
      if (fileData) {
        return res.end(ok({ path: reqPath, ...fileData }));
      }

      // Generic fallback for any unknown path
      const ext = reqPath.split('.').pop() || '';
      const mimeMap = {
        ts: 'text/typescript', vue: 'text/x-vue', js: 'text/javascript',
        json: 'application/json', md: 'text/markdown', css: 'text/css',
        html: 'text/html', sh: 'text/x-sh', txt: 'text/plain',
      };
      const langMap = {
        ts: 'typescript', vue: 'vue', js: 'javascript', json: 'json',
        md: 'markdown', css: 'css', html: 'html', sh: 'shellscript',
      };
      const mime = mimeMap[ext] || 'text/plain';
      const lang = langMap[ext] || ext;
      const fallbackContent = `// ${reqPath}\n// (stub: content not seeded for this path)\n`;
      return res.end(ok({
        path: reqPath,
        content: fallbackContent,
        encoding: 'utf-8',
        mime,
        language_id: lang || undefined,
        size: fallbackContent.length,
        line_count: 2,
        is_binary: false,
        etag: 'etag_fallback_' + reqPath.replace(/[^a-z0-9]/gi, '_'),
        truncated: false,
      }));
    }

    // ---- file upload ----
    // POST /api/v1/files  (multipart/form-data: file, name?, expires_in_sec?)
    // The stub does not parse multipart fully — it just returns a synthesised FileMeta.
    if (stripped === '/files' && method === 'POST') {
      const fileId = ulid('file_');
      // Try to extract filename from Content-Disposition if possible; fall back to generic name.
      const nameMatch = body.match(/filename="([^"]+)"/);
      const fileName = nameMatch ? nameMatch[1] : 'upload.png';
      const fileMeta = {
        id: fileId,
        name: fileName,
        media_type: 'image/png',
        size: body.length,
        created_at: now(),
      };
      return res.end(ok(fileMeta));
    }

    // ---- tools / mcp ----
    if (stripped === '/tools' && method === 'GET') {
      return res.end(ok({
        tools: [
          { name: 'read', description: 'Read a file from disk', input_schema: {}, source: 'builtin' },
          { name: 'bash', description: 'Run a shell command', input_schema: {}, source: 'builtin' },
          { name: 'edit', description: 'Edit a file with old/new string replacement', input_schema: {}, source: 'builtin' },
          { name: 'write', description: 'Write a new file', input_schema: {}, source: 'builtin' },
          { name: 'ls', description: 'List directory contents', input_schema: {}, source: 'builtin' },
          { name: 'grep', description: 'Search file contents with regex', input_schema: {}, source: 'builtin' },
        ],
      }));
    }
    if (stripped === '/mcp/servers' && method === 'GET') {
      return res.end(ok({ servers: [] }));
    }

    // Fallback
    return res.end(ok({}));
  });
});

// ---- WS ----

const wss = new WebSocketServer({ server, path: '/api/v1/ws' });

wss.on('connection', (ws) => {
  sockets.add(ws);

  ws.send(JSON.stringify({
    type: 'server_hello',
    timestamp: now(),
    payload: {
      server_id: 'stub',
      heartbeat_ms: 30000,
      max_event_buffer_size: 1000,
      capabilities: { event_batching: false, compression: false },
    },
  }));

  const ping = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'ping', timestamp: now(), payload: { nonce: ulid('n_') } }));
    }
  }, 30000);

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(String(raw)); } catch { return; }

    if (m.type === 'client_hello') {
      ws.send(JSON.stringify({
        type: 'ack', id: m.id, code: 0, msg: 'success',
        payload: {
          accepted_subscriptions: m.payload?.subscriptions || [],
          resync_required: [],
        },
      }));
    }

    if (m.type === 'subscribe') {
      ws.send(JSON.stringify({
        type: 'ack', id: m.id, code: 0, msg: 'success',
        payload: {
          accepted: m.payload?.session_ids || [],
          not_found: [],
          resync_required: [],
        },
      }));
    }

    if (m.type === 'unsubscribe') {
      ws.send(JSON.stringify({ type: 'ack', id: m.id, code: 0, msg: 'success', payload: {} }));
    }

    if (m.type === 'abort') {
      ws.send(JSON.stringify({
        type: 'ack', id: m.id, code: 0, msg: 'success',
        payload: { aborted: false },
      }));
    }

    if (m.type === 'pong') {
      // heartbeat response — no-op
    }

    if (m.type === 'watch_fs_add' || m.type === 'watch_fs_remove') {
      ws.send(JSON.stringify({
        type: 'ack', id: m.id, code: 0, msg: 'success',
        payload: { watched_paths: m.payload?.paths || [] },
      }));
    }
  });

  ws.on('close', () => {
    clearInterval(ping);
    sockets.delete(ws);
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[stub-daemon] REST+WS on http://127.0.0.1:${PORT}  (Ctrl+C to stop)`);
  console.log(`[stub-daemon] Routes: /api/v1/* (healthz, models, providers, auth/login, auth/logout, auth/status)`);
  console.log(`[stub-daemon] WS path: /api/v1/ws`);
  console.log(`[stub-daemon] Event mode: ${RAW_EVENTS_MODE ? 'RAW agent-core events (STUB_RAW_EVENTS=1)' : 'projected event.* protocol (default)'}`);
  console.log(`[stub-daemon] Seeded ${sessions.length} sessions, ${Object.values(messages).flat().length} messages`);
});
