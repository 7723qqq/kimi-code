// apps/kimi-web/src/components/__tests__/ConversationPane.test.ts
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import ConversationPane from '../ConversationPane.vue';
import type { ChatTurn, ConversationStatus, TaskItem } from '../../types';
import i18n from '../../i18n';

// ConversationPane (and its child Composer) use vue-i18n.
const global = { plugins: [i18n] };

// Inline fixtures — no dependency on the deleted mock.ts

const status: ConversationStatus = {
  model: 'opus-4.7',
  ctxUsed: 38000,
  ctxMax: 200000,
  permission: 'manual',
  branch: 'feat/api-client',
  cwd: '/home/user/project',
  isGitRepo: true,
};

const turns: ChatTurn[] = [
  {
    id: 't1',
    role: 'user',
    no: 1,
    text: '把 api client 的超时改成可配置，然后跑测试、更新文档',
  },
  {
    id: 't2',
    role: 'assistant',
    no: 2,
    text: '计划：read client.ts → patch timeout → pnpm test → docs。开始执行。',
    tools: [
      { id: 'tool1', name: 'read', arg: '· src/api/client.ts', status: 'ok', timing: '12ms' },
    ],
  },
  {
    id: 't3',
    role: 'assistant',
    no: 3,
    text: '需要你确认这次写入（manual 模式每次写文件都会停下来）：',
    approval: {
      kind: 'diff',
      path: 'src/api/client.ts',
      diff: [
        { kind: 'ctx', gutter: '22', text: ' export function createClient(opts) {' },
        { kind: 'rem', gutter: '23', text: '- const timeout = 5000;' },
        { kind: 'add', gutter: '23', text: '+ const timeout = opts.timeoutMs ?? 5000;' },
      ],
    },
  },
];

const changes = [
  { path: 'src/api/client.ts', status: 'modified' },
  { path: 'src/api/types.ts', status: 'added' },
];

const gitInfo = { branch: 'feat/api-client', ahead: 0, behind: 0 };

const tasks: TaskItem[] = [
  { id: 'k1', name: 'build docs', kind: 'subagent', state: 'run', timing: '运行中 · 0:12', meta: '$ pnpm -C docs build' },
  { id: 'k2', name: 'lint', kind: 'task', state: 'done', timing: '完成 · 0.6s', output: ['$ eslint src', '✓ 0 problems'] },
];

const props = { turns, changes, gitInfo, tasks, status };

describe('ConversationPane', () => {
  it('默认显示 chat 面板', () => {
    const w = mount(ConversationPane, { props, global });
    expect(w.findComponent({ name: 'ChatPane' }).exists()).toBe(true);
    expect(w.findComponent({ name: 'DiffView' }).exists()).toBe(false);
  });

  it('点击 ~/diff 切到 diff 面板', async () => {
    const w = mount(ConversationPane, { props, global });
    await w.findAll('.tb')[1]!.trigger('click');
    expect(w.findComponent({ name: 'DiffView' }).exists()).toBe(true);
    expect(w.findComponent({ name: 'ChatPane' }).exists()).toBe(false);
  });

  it('diff 面板显示改动文件列表', async () => {
    const w = mount(ConversationPane, { props, global });
    await w.findAll('.tb')[1]!.trigger('click');
    expect(w.text()).toContain('client.ts');
    expect(w.text()).toContain('types.ts');
  });

  it('点击 ~/tasks 切到 tasks 面板', async () => {
    const w = mount(ConversationPane, { props, global });
    await w.findAll('.tb')[2]!.trigger('click');
    expect(w.findComponent({ name: 'TasksPane' }).exists()).toBe(true);
  });

  it('状态行与输入框始终存在', () => {
    const w = mount(ConversationPane, { props, global });
    expect(w.findComponent({ name: 'StatusLine' }).exists()).toBe(true);
    expect(w.findComponent({ name: 'Composer' }).exists()).toBe(true);
  });

  it('有改动时 ~/diff 标签显示指示点', () => {
    const w = mount(ConversationPane, { props, global });
    // The dot element should exist because changesCount > 0
    expect(w.find('.d').exists()).toBe(true);
  });

  it('无改动时 ~/diff 标签不显示指示点', () => {
    const w = mount(ConversationPane, { props: { ...props, changes: [] }, global });
    expect(w.find('.d').exists()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Content alignment toggle + max-width reading column
  // -------------------------------------------------------------------------
  describe('content alignment', () => {
    beforeEach(() => localStorage.clear());

    it('chat 内容被包进限宽容器，默认居中', () => {
      const w = mount(ConversationPane, { props, global });
      const wrap = w.find('.content-wrap');
      expect(wrap.exists()).toBe(true);
      expect(wrap.classes()).toContain('align-center');
      // ChatPane lives inside the wrapper
      expect(wrap.findComponent({ name: 'ChatPane' }).exists()).toBe(true);
    });

    it('点击左对齐按钮切到 align-left 并持久化', async () => {
      const w = mount(ConversationPane, { props, global });
      // first align button = left
      await w.findAll('.align-btn')[0]!.trigger('click');
      expect(w.find('.content-wrap').classes()).toContain('align-left');
      expect(localStorage.getItem('kimi-web.content-align')).toBe('left');
    });

    it('从 localStorage 恢复 left 对齐', () => {
      localStorage.setItem('kimi-web.content-align', 'left');
      const w = mount(ConversationPane, { props, global });
      expect(w.find('.content-wrap').classes()).toContain('align-left');
    });

    it('切回居中并持久化', async () => {
      localStorage.setItem('kimi-web.content-align', 'left');
      const w = mount(ConversationPane, { props, global });
      // second align button = center
      await w.findAll('.align-btn')[1]!.trigger('click');
      expect(w.find('.content-wrap').classes()).toContain('align-center');
      expect(localStorage.getItem('kimi-web.content-align')).toBe('center');
    });
  });
});
