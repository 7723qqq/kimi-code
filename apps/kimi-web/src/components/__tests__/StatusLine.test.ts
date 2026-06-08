// apps/kimi-web/src/components/__tests__/StatusLine.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import StatusLine from '../StatusLine.vue';
import type { ConversationStatus } from '../../types';

// StatusLine uses vue-i18n; install the plugin. Default locale is English.
const global = { plugins: [i18n] };

const status: ConversationStatus = {
  model: 'opus-4.7',
  ctxUsed: 38000,
  ctxMax: 200000,
  permission: 'manual',
  branch: 'feat/api-client',
  cwd: '/home/user/project',
  isGitRepo: true,
};

describe('StatusLine', () => {
  it('显示模型、上下文、权限', () => {
    const w = mount(StatusLine, { props: { status }, global });
    const text = w.text();
    expect(text).toContain('opus-4.7');
    expect(text).toContain('38k/200k');
    expect(text).toContain('Permission');
    expect(text).toContain('Manual');
  });

  it('不再在状态行重复显示目录/分支(已移到工作区切换器)', () => {
    const w = mount(StatusLine, { props: { status }, global });
    expect(w.find('.cwd-kv').exists()).toBe(false);
    expect(w.find('.branch-kv').exists()).toBe(false);
  });

  it('上下文进度条宽度按比例计算', () => {
    const w = mount(StatusLine, { props: { status }, global });
    const bar = w.get('.bar i');
    expect(bar.attributes('style')).toContain('width: 19%');
  });

  it('仅传 status 时不报错（connection/activity 有默认值）', () => {
    const w = mount(StatusLine, { props: { status }, global });
    expect(w.exists()).toBe(true);
    expect(w.text()).toContain('opus-4.7');
  });

  it('点击 perm 区域打开 popover，选择 auto 发出 setPermission 事件', async () => {
    const w = mount(StatusLine, { props: { status }, global });
    // Click opens the popover (no immediate emit on the pill click).
    await w.get('.perm-kv .kv-btn').trigger('click');
    expect(w.find('.perm-popover').exists()).toBe(true);
    // The popover lists 3 modes with one-line descriptions.
    const rows = w.findAll('.perm-popover .pop-row');
    expect(rows.length).toBe(3);
    // Each row carries a description string.
    expect(w.get('.perm-popover').text()).toContain('Auto-approve');
    // Choosing 'auto' (the 2nd row) emits setPermission('auto').
    await rows[1]!.trigger('click');
    expect(w.emitted('setPermission')).toBeTruthy();
    expect(w.emitted('setPermission')![0]).toEqual(['auto']);
  });

  it('perm 区域显示权限标签和权限名', () => {
    const w = mount(StatusLine, { props: { status }, global });
    expect(w.get('.perm-kv').text()).toContain('Permission');
    expect(w.get('.perm-kv').text()).toContain('Manual');
  });

  it('auto 权限时显示"Auto"', () => {
    const autoStatus: ConversationStatus = { ...status, permission: 'auto' };
    const w = mount(StatusLine, { props: { status: autoStatus }, global });
    expect(w.get('.perm-kv').text()).toContain('Auto');
  });

  it('yolo 权限时显示"YOLO"，perm 文字用 --err 颜色', () => {
    const yoloStatus: ConversationStatus = { ...status, permission: 'yolo' };
    const w = mount(StatusLine, { props: { status: yoloStatus }, global });
    expect(w.get('.perm-kv').text()).toContain('YOLO');
    const permVal = w.get('.perm-val');
    expect(permVal.attributes('style')).toContain('var(--err)');
  });

  it('perm 区域有正确的 tooltip', () => {
    const w = mount(StatusLine, { props: { status }, global });
    expect(w.get('.perm-kv .kv-btn').attributes('title')).toBe('Click to choose approval mode');
  });

  it('使用率 ≥ 80% 时显示 /compact chip', () => {
    const highCtxStatus: ConversationStatus = { ...status, ctxUsed: 170000, ctxMax: 200000 };
    const w = mount(StatusLine, { props: { status: highCtxStatus }, global });
    expect(w.find('.compact-chip').exists()).toBe(true);
  });

  it('使用率 < 80% 时不显示 /compact chip', () => {
    const w = mount(StatusLine, { props: { status }, global });
    expect(w.find('.compact-chip').exists()).toBe(false);
  });

  it('点击 /compact chip 发出 compact 事件', async () => {
    const highCtxStatus: ConversationStatus = { ...status, ctxUsed: 170000, ctxMax: 200000 };
    const w = mount(StatusLine, { props: { status: highCtxStatus }, global });
    await w.get('.compact-chip').trigger('click');
    expect(w.emitted('compact')).toBeTruthy();
  });

  it('activity=running 时显示"Running…"和中断按钮', () => {
    const w = mount(StatusLine, { props: { status, activity: 'running', connection: 'connected' }, global });
    expect(w.text()).toContain('Running…');
    expect(w.find('.interrupt-btn').exists()).toBe(true);
  });

  it('点击中断按钮发出 interrupt 事件', async () => {
    const w = mount(StatusLine, { props: { status, activity: 'running', connection: 'connected' }, global });
    await w.get('.interrupt-btn').trigger('click');
    expect(w.emitted('interrupt')).toBeTruthy();
  });

  it('activity=awaiting-approval 时显示"Awaiting approval"且无中断按钮', () => {
    const w = mount(StatusLine, {
      props: { status, activity: 'awaiting-approval', connection: 'connected' },
      global,
    });
    expect(w.text()).toContain('Awaiting approval');
    expect(w.find('.interrupt-btn').exists()).toBe(false);
  });

  it('model 段落有 title="Click to switch model"', () => {
    const w = mount(StatusLine, { props: { status }, global });
    const modelKv = w.get('.model-kv');
    expect(modelKv.attributes('title')).toBe('Click to switch model');
  });

  it('点击 model 段落发出 pickModel 事件', async () => {
    const w = mount(StatusLine, { props: { status }, global });
    await w.get('.model-kv').trigger('click');
    expect(w.emitted('pickModel')).toBeTruthy();
  });

  it('未连接时不显示 conn-dot，显示"Disconnected"提示', () => {
    const w = mount(StatusLine, { props: { status, connection: 'disconnected' }, global });
    expect(w.find('.conn-dot').exists()).toBe(false);
    expect(w.text()).toContain('Disconnected');
  });

  it('已连接时不显示连接状态文字', () => {
    const w = mount(StatusLine, { props: { status, connection: 'connected' }, global });
    expect(w.find('.disconn-label').exists()).toBe(false);
    expect(w.text()).not.toContain('Disconnected');
  });

  // --- Plan mode pill ---------------------------------------------------------

  it('渲染 plan 标签，默认 off', () => {
    const w = mount(StatusLine, { props: { status }, global });
    const plan = w.get('.plan-kv');
    expect(plan.text()).toContain('Plan');
    expect(plan.text()).toContain('off');
    expect(plan.classes()).not.toContain('plan-on');
  });

  it('planMode=true 时显示 on 且有 plan-on 激活样式', () => {
    const w = mount(StatusLine, { props: { status, planMode: true }, global });
    const plan = w.get('.plan-kv');
    expect(plan.text()).toContain('on');
    expect(plan.classes()).toContain('plan-on');
  });

  it('点击 plan 区域发出 togglePlan 事件', async () => {
    const w = mount(StatusLine, { props: { status }, global });
    await w.get('.plan-kv').trigger('click');
    expect(w.emitted('togglePlan')).toBeTruthy();
  });

  // --- Thinking selector ------------------------------------------------------

  it('渲染 thinking 当前等级', () => {
    const w = mount(StatusLine, { props: { status, thinking: 'medium' }, global });
    expect(w.get('.think-kv').text()).toContain('medium');
  });

  it('点击 thinking 打开 popover 列出 6 个等级，选择发出 setThinking', async () => {
    const w = mount(StatusLine, { props: { status, thinking: 'high' }, global });
    await w.get('.think-kv .kv-btn').trigger('click');
    const rows = w.findAll('.think-popover .pop-row');
    expect(rows.length).toBe(6);
    // The first level is 'off'.
    expect(rows[0]!.text()).toContain('off');
    await rows[0]!.trigger('click');
    expect(w.emitted('setThinking')).toBeTruthy();
    expect(w.emitted('setThinking')![0]).toEqual(['off']);
  });

  it('thinking 默认等级为 high（未传 prop 时）', () => {
    const w = mount(StatusLine, { props: { status }, global });
    expect(w.get('.think-kv').text()).toContain('high');
  });
});
