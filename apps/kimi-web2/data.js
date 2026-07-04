/* Kimi Code Web prototype — stub data + a tiny store (no backend). */
(function () {
  'use strict';

  /* ----------------------------- stub data ----------------------------- */
  const workspaces = [
    { id: 'w1', name: 'kimi-code-web3', root: '~/code/kimi-code-web3', branch: 'main', add: 397, del: 358 },
    { id: 'w2', name: 'kimi-code-web2', root: '~/code/kimi-code-web2', branch: 'dev', add: 12, del: 4 },
    { id: 'w3', name: 'kimi-code-dev2', root: '~/code/kimi-code-dev2', branch: 'main', add: 0, del: 0 },
  ];

  // time is minutes-ago; rendered to a relative label.
  const sessions = [
    { id: 's1', ws: 'w1', title: '继续完成这个任务，现在的问题是 前端的 UI 不对', ago: 1, busy: true, unread: false, pending: { a: 0, q: 0 } },
    { id: 's2', ws: 'w1', title: '调研一个任务，现在 TUI 里支持了思考等级', ago: 22 * 60, busy: false, unread: false, pending: { a: 1, q: 0 } },
    { id: 's3', ws: 'w1', title: '修复一个问题，kimi-web 里的发送队列', ago: 26 * 60, busy: false, unread: true, pending: { a: 0, q: 1 } },
    { id: 's4', ws: 'w1', title: '我不想为了彩蛋而维护 kimi-web 的动画', ago: 27 * 60, busy: false, unread: false, pending: { a: 0, q: 0 } },
    { id: 's5', ws: 'w2', title: '看一下我们 main 上的最新的仓库', ago: 2 * 24 * 60, busy: false, unread: false, pending: { a: 0, q: 0 } },
    { id: 's6', ws: 'w2', title: 'Fork: 看一下签名的实现', ago: 2 * 24 * 60, busy: false, unread: false, pending: { a: 0, q: 0 } },
  ];

  const richConvo = [
    { type: 'user', text: '继续完成这个任务，现在的问题是 前端的 UI 不对，帮我捋一下，给出一份从设计系统出发的重做方案。' },
    { type: 'lead', html: '我先停下增量修补，按设计系统从第一性原理重新搭。这一版只关心三件事：<strong>信息层级、间距节奏、状态用填充而非边框</strong>。下面是我对当前问题的判断和重做计划。' },
    { type: 'think', html: '<p>用户说"看不出区别"且"和例子大相径庭"。最可能的根因不是样式没改，而是旧的蓝色强调偏好把中性强调色盖掉了。</p><p>设计上，Kimi 的交互强调是 kimiDark（近黑/近白），蓝色只给品牌与数据。所以移除蓝色强调项，让默认体验回归中性，是第一刀。</p>' },
    { type: 'code', lang: 'style.css · tokens', code: '/* Interaction emphasis = kimiDark, not blue */\n:root {\n  --color-accent: rgba(0, 0, 0, 0.9);\n  --color-info:   #1783ff;  /* brand / data only */\n  --radius-md:     10px;\n}' },
    { type: 'tool', name: '运行', arg: 'pnpm --filter @moonshot-ai/kimi-web check:style', ok: '通过', open: true, body: 'check-style: 9 finding(s) across 4 rule(s). (baseline mode — not failing)\n✓ built in 8.76s' },
    { type: 'toolGroup', count: 2, state: '已完成', items: [
      { name: '搜索', arg: 'var\\(--color-accent\\)', ok: '53 处' },
      { name: '运行', arg: 'pnpm --filter @moonshot-ai/kimi-web build', ok: '通过' },
    ] },
    { type: 'approval', title: '需要确认 · 运行写入命令', body: 'Agent 想在工作区执行以下命令，这会修改你的文件：', cmd: 'pnpm --filter @moonshot-ai/kimi-web build' },
    { type: 'question', title: '一个问题 · 想确认你的偏好', body: '设置弹窗里，你更希望分段控件的选中态是哪种？', options: [
      { k: 'A', t: '深色胶囊（推荐）', d: '和参考样稿一致，选中更明确。' },
      { k: 'B', t: '浅色浮起', d: '更克制，但选中对比更弱。' },
    ] },
    { type: 'prose', html: '计划分四步：先纠正强调色，再把设置弹窗对齐参考结构，随后用同样的 token 重做侧栏与聊天主表面，最后把这套设计落回真实组件。要不要我继续？' },
    { type: 'status', text: '已完成本轮 · 等待你的下一条输入' },
    { type: 'user', text: '继续，把设置弹窗先按参考对齐。' },
  ];

  const shortConvo = [
    { type: 'user', text: '现在这个会话还空着，随便说点什么测试一下切换。' },
    { type: 'lead', html: '好的，这是一条简短的助手回复，用来验证会话切换与空态之外的渲染。' },
    { type: 'prose', html: '你可以继续问，我会按 Kimi 的 calm、填充式、hairline 分隔的样式来呈现。' },
  ];

  const conversations = { s1: richConvo, s2: shortConvo, s3: shortConvo, s4: shortConvo, s5: shortConvo, s6: shortConvo };

  const models = [
    { id: 'm1', name: 'Coding Model', provider: 'moonshot', starred: true, thinking: 'on' },
    { id: 'm2', name: 'Kimi K2', provider: 'moonshot', starred: true, thinking: 'off' },
    { id: 'm3', name: 'GPT-5', provider: 'openai', starred: false, thinking: 'off' },
    { id: 'm4', name: 'Claude 4.5', provider: 'anthropic', starred: false, thinking: 'off' },
  ];

  const config = {
    defaultModel: 'm1',
    defaultPermission: 'yolo',
    defaultThinking: true,
    defaultPlanMode: false,
    mergeSkills: true,
    telemetry: true,
    serverVersion: '0.1.2',
    daemon: 'localhost:58627',
  };

  /* ----------------------------- store --------------------------------- */
  const state = {
    currentSessionId: 's1',
    theme: 'light',          // 'light' | 'dark' | 'system'
    fontSize: 14,
    lang: 'zh',              // 'zh' | 'en'
    permission: 'yolo',      // 'manual' | 'auto' | 'yolo'
    modelId: 'm1',
    planMode: false,
    swarmMode: false,
    rightPanel: null,        // null | { kind, data }
    collapsed: {},           // workspaceId -> bool
    expanded: {},            // workspaceId -> bool (show-more)
    authed: true,            // server token gate
  };

  const listeners = new Set();
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  function emit() { listeners.forEach((fn) => fn(state)); }
  function set(patch) { Object.assign(state, patch); emit(); }

  function session(id) { return sessions.find((s) => s.id === id); }
  function workspace(id) { return workspaces.find((w) => w.id === id); }
  function convo(id) { return conversations[id] || []; }
  function model(id) { return models.find((m) => m.id === id); }

  function relTime(ago) {
    if (ago < 2) return '刚刚';
    if (ago < 60) return ago + 'm';
    if (ago < 24 * 60) return Math.round(ago / 60) + 'h';
    return Math.round(ago / (24 * 60)) + 'd';
  }

  window.Store = {
    workspaces, sessions, conversations, models, config,
    state, subscribe, set,
    session, workspace, convo, model, relTime,
  };
})();
