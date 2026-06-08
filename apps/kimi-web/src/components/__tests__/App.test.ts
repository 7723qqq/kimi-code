// apps/kimi-web/src/components/__tests__/App.test.ts
// App now loads from the daemon. In jsdom there's no daemon, so load() fails gracefully.
// Assert that App mounts Sidebar and ConversationPane without throwing.
import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import App from '../../App.vue';

// App renders Sidebar, which uses vue-i18n; install the plugin.
const global = { plugins: [i18n] };

const RAIL_EXPANDED_KEY = 'kimi-web.rail-expanded';

afterEach(() => {
  localStorage.clear();
});

describe('App', () => {
  it('装配左侧栏与对话栏', () => {
    const w = mount(App, { global });
    expect(w.findComponent({ name: 'Sidebar' }).exists()).toBe(true);
    expect(w.findComponent({ name: 'ConversationPane' }).exists()).toBe(true);
  });

  it('daemon 不可用时仍然挂载（无未处理的 rejection）', async () => {
    // In jsdom there's no daemon running; load() must catch the fetch error gracefully.
    const w = mount(App, { global });
    // Wait one tick to let onMounted fire and load() to start
    await new Promise((r) => setTimeout(r, 0));
    // App is still mounted; no unhandled rejection should propagate
    expect(w.findComponent({ name: 'Sidebar' }).exists()).toBe(true);
    expect(w.findComponent({ name: 'ConversationPane' }).exists()).toBe(true);
  });

  it('默认折叠态，sidebar 收到 railExpanded=false', () => {
    const w = mount(App, { global });
    expect(w.findComponent({ name: 'Sidebar' }).props('railExpanded')).toBe(false);
  });

  it('挂载时从 localStorage 读取持久化的展开态', () => {
    localStorage.setItem(RAIL_EXPANDED_KEY, 'true');
    const w = mount(App, { global });
    expect(w.findComponent({ name: 'Sidebar' }).props('railExpanded')).toBe(true);
    // The rail is rendered in its wide mode.
    expect(w.find('.rail').classes()).toContain('expanded');
  });

  it('toggleRailExpand 切换并持久化到 localStorage', async () => {
    const w = mount(App, { global });
    const sidebar = w.findComponent({ name: 'Sidebar' });
    sidebar.vm.$emit('toggleRailExpand');
    await w.vm.$nextTick();
    expect(sidebar.props('railExpanded')).toBe(true);
    expect(localStorage.getItem(RAIL_EXPANDED_KEY)).toBe('true');
  });
});
