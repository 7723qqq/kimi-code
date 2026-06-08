// apps/kimi-web/src/components/__tests__/Sidebar.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import Sidebar from '../Sidebar.vue';
import type { Session, WorkspaceGroup, WorkspaceView } from '../../types';

// Sidebar uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

const activeWorkspace: WorkspaceView = {
  id: '/Users/me/kimi-code-web',
  name: 'kimi-code-web',
  root: '/Users/me/kimi-code-web',
  shortPath: '~/kimi-code-web',
  branch: 'main',
  sessionCount: 5,
};

const sessions: Session[] = [
  { id: 's1', title: '超时改为可配置', time: 'just now · 进行中', status: 'running' },
  { id: 's2', title: '重构 retry 退避', time: '2h ago', status: 'idle' },
  { id: 's3', title: '补全 client 测试', time: '昨天 14:20', status: 'idle' },
  { id: 's4', title: 'api 错误码映射', time: '周一 09:05', status: 'idle' },
  { id: 's5', title: '导出会话 zip 调试', time: '3 天前', status: 'idle' },
];

const groups: WorkspaceGroup[] = [{ workspace: activeWorkspace, sessions }];

const props = {
  workspaces: [activeWorkspace],
  activeWorkspace,
  activeWorkspaceId: activeWorkspace.id,
  scope: 'current' as const,
  sessions,
  groups,
  activeId: 's1',
};

describe('Sidebar', () => {
  it('显示工作区名与新建入口', () => {
    const w = mount(Sidebar, { props, global });
    expect(w.text()).toContain('kimi-code-web');
    expect(w.text()).toContain('New');
  });

  it('渲染所有会话，活动会话高亮', () => {
    const w = mount(Sidebar, { props, global });
    expect(w.findAll('.se')).toHaveLength(sessions.length);
    expect(w.get('.se.on').text()).toContain('超时改为可配置');
  });

  it('点击会话行发出 select 事件并带会话 id', async () => {
    const w = mount(Sidebar, { props, global });
    await w.findAll('.se')[0]!.trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0]).toEqual(['s1']);
  });

  it('点击新建发出 create 事件', async () => {
    const w = mount(Sidebar, { props, global });
    await w.find('.new').trigger('click');
    expect(w.emitted('create')).toBeTruthy();
  });

  it('无会话时显示空状态提示', () => {
    const w = mount(Sidebar, {
      props: { ...props, sessions: [], groups: [], activeId: '' },
      global,
    });
    expect(w.text()).toContain('No sessions yet');
    expect(w.findAll('.se')).toHaveLength(0);
  });

  it('搜索框按标题子串过滤会话（大小写不敏感）', async () => {
    const w = mount(Sidebar, { props, global });
    const input = w.find('.search-input');
    await input.setValue('retry');
    // Only '重构 retry 退避' contains 'retry'
    expect(w.findAll('.se')).toHaveLength(1);
    expect(w.text()).toContain('重构 retry 退避');
  });

  it('搜索有内容但无匹配时显示"无匹配会话"', async () => {
    const w = mount(Sidebar, { props, global });
    await w.find('.search-input').setValue('zzznomatch');
    expect(w.findAll('.se')).toHaveLength(0);
    expect(w.text()).toContain('No matching sessions');
  });

  it('双击标题开启内联重命名，Enter 发出 rename 事件', async () => {
    const w = mount(Sidebar, { props, global });
    const titleSpan = w.findAll('.t')[1]!; // s2
    await titleSpan.trigger('dblclick');
    const input = w.find('.rename-input');
    expect(input.exists()).toBe(true);
    await input.setValue('新标题');
    await input.trigger('keydown', { key: 'Enter', code: 'Enter' });
    expect(w.emitted('rename')).toBeTruthy();
    expect(w.emitted('rename')![0]).toEqual(['s2', '新标题']);
  });

  it('重命名时 Esc 取消，不发出 rename 事件', async () => {
    const w = mount(Sidebar, { props, global });
    const titleSpan = w.findAll('.t')[1]!;
    await titleSpan.trigger('dblclick');
    const input = w.find('.rename-input');
    await input.setValue('变了');
    await input.trigger('keydown', { key: 'Escape', code: 'Escape' });
    expect(w.emitted('rename')).toBeFalsy();
    expect(w.find('.rename-input').exists()).toBe(false);
  });

  it('删除确认后发出 delete 事件', async () => {
    const w = mount(Sidebar, { props, global });
    // Open kebab menu for s2
    const kebab = w.findAll('.kebab')[1]!;
    await kebab.trigger('click');
    // Click Delete in menu
    const menuItems = w.findAll('.menu-item');
    const delItem = menuItems.find((el) => el.text().includes('Delete'));
    await delItem!.trigger('click');
    // Confirm
    const confirmBtn = w.find('.btn-confirm');
    await confirmBtn.trigger('click');
    expect(w.emitted('delete')).toBeTruthy();
    expect(w.emitted('delete')![0]).toEqual(['s2']);
  });

  it('删除取消后不发出 delete 事件', async () => {
    const w = mount(Sidebar, { props, global });
    const kebab = w.findAll('.kebab')[1]!;
    await kebab.trigger('click');
    const delItem = w.findAll('.menu-item').find((el) => el.text().includes('Delete'));
    await delItem!.trigger('click');
    await w.find('.btn-cancel').trigger('click');
    expect(w.emitted('delete')).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // Workspace rail + column-header scope + attention marker
  // -------------------------------------------------------------------------

  it('列头展示活动工作区名（只读，切换交给侧栏）', () => {
    const w = mount(Sidebar, { props, global });
    expect(w.find('.ch-name').exists()).toBe(true);
    expect(w.find('.ch-name').text()).toContain('kimi-code-web');
  });

  it('侧栏每个工作区渲染一个 chip，活动 chip 高亮', () => {
    const second: WorkspaceView = {
      id: '/Users/me/other',
      name: 'other',
      root: '/Users/me/other',
      shortPath: '~/other',
      branch: 'dev',
      sessionCount: 1,
    };
    const w = mount(Sidebar, {
      props: { ...props, workspaces: [activeWorkspace, second] },
      global,
    });
    const chips = w.findAll('.wschip');
    expect(chips.length).toBe(2);
    // The active chip carries the .on class.
    expect(chips[0]!.classes()).toContain('on');
    expect(chips[1]!.classes()).not.toContain('on');
  });

  it('点击工作区 chip 发出 selectWorkspace 事件', async () => {
    const second: WorkspaceView = {
      id: '/Users/me/other',
      name: 'other',
      root: '/Users/me/other',
      shortPath: '~/other',
      branch: 'dev',
      sessionCount: 1,
    };
    const w = mount(Sidebar, {
      props: { ...props, workspaces: [activeWorkspace, second] },
      global,
    });
    await w.findAll('.wschip')[1]!.trigger('click');
    expect(w.emitted('selectWorkspace')).toBeTruthy();
    expect(w.emitted('selectWorkspace')![0]).toEqual([second.id]);
  });

  it('列头作用域开关切换到全部工作区发出 setScope 事件', async () => {
    const w = mount(Sidebar, { props, global });
    await w.find('.ch-scope').trigger('click');
    expect(w.emitted('setScope')).toBeTruthy();
    expect(w.emitted('setScope')![0]).toEqual(['all']);
  });

  it('点击侧栏 + 按钮发出 addWorkspace 事件', async () => {
    const w = mount(Sidebar, { props, global });
    await w.find('.railadd').trigger('click');
    expect(w.emitted('addWorkspace')).toBeTruthy();
  });

  it('attention > 0 的会话显示带计数的待处理标记', () => {
    const w = mount(Sidebar, {
      props: { ...props, attentionBySession: { s2: 2 } },
      global,
    });
    const pill = w.find('.attn');
    expect(pill.exists()).toBe(true);
    expect(pill.text()).toContain('2');
  });

  it('全部工作区范围下按工作区分组渲染组头与组内新建', async () => {
    const w = mount(Sidebar, {
      props: { ...props, scope: 'all' as const },
      global,
    });
    expect(w.find('.gh').exists()).toBe(true);
    expect(w.find('.gh').text()).toContain('kimi-code-web');
    // group-level + creates a session in that workspace
    await w.find('.gh-add').trigger('click');
    expect(w.emitted('createInWorkspace')).toBeTruthy();
    expect(w.emitted('createInWorkspace')![0]).toEqual([activeWorkspace.id]);
  });
});
