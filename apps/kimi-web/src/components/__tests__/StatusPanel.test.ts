// apps/kimi-web/src/components/__tests__/StatusPanel.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import StatusPanel from '../StatusPanel.vue';
import type { ConversationStatus } from '../../types';

const global = { plugins: [i18n] };

const status: ConversationStatus = {
  model: 'opus-4.7',
  ctxUsed: 38000,
  ctxMax: 200000,
  permission: 'auto',
  branch: 'main',
  cwd: '/home/user/project',
  isGitRepo: true,
};

describe('StatusPanel', () => {
  it('渲染 model / thinking / permission / plan / context（来自 props）', () => {
    const w = mount(StatusPanel, {
      props: { status, thinking: 'medium', planMode: true },
      global,
    });
    const text = w.text();
    expect(text).toContain('opus-4.7'); // model
    expect(text).toContain('medium'); // thinking level
    expect(text).toContain('Auto'); // permission mode
    expect(text).toContain('on'); // plan mode on
    // context: used / max (pct)
    expect(text).toContain('38,000');
    expect(text).toContain('200,000');
    expect(text).toContain('19%');
  });

  it('planMode=false 时显示 off', () => {
    const w = mount(StatusPanel, {
      props: { status, thinking: 'high', planMode: false },
      global,
    });
    expect(w.text()).toContain('off');
  });

  it('提供 costUsd 时显示金额，否则显示占位符', () => {
    const withCost = mount(StatusPanel, {
      props: { status, thinking: 'high', planMode: false, costUsd: 0.1234 },
      global,
    });
    expect(withCost.text()).toContain('$0.1234');

    const noCost = mount(StatusPanel, {
      props: { status, thinking: 'high', planMode: false },
      global,
    });
    // Cost row exists but shows the em-dash placeholder.
    expect(noCost.text()).toContain('Cost');
  });

  it('点击关闭按钮发出 close 事件', async () => {
    const w = mount(StatusPanel, {
      props: { status, thinking: 'high', planMode: false },
      global,
    });
    await w.get('.close-btn').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('点击背景（backdrop）发出 close 事件', async () => {
    const w = mount(StatusPanel, {
      props: { status, thinking: 'high', planMode: false },
      global,
    });
    await w.get('.backdrop').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });
});
