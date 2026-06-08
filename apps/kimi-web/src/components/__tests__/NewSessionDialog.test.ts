// apps/kimi-web/src/components/__tests__/NewSessionDialog.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import NewSessionDialog from '../NewSessionDialog.vue';

// NewSessionDialog uses vue-i18n; install the plugin. Default locale is English.
const global = { plugins: [i18n] };

const recentCwds = ['/Users/alice/project', '/home/bob/work', '/var/code/repo'];

describe('NewSessionDialog', () => {
  it('渲染标题"New session"', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    expect(w.text()).toContain('New session');
  });

  it('有 recentCwds 时预填充第一个路径', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds }, global });
    const input = w.find('#ns-cwd') as ReturnType<typeof w.find>;
    expect((input.element as HTMLInputElement).value).toBe(recentCwds[0]);
  });

  it('无 recentCwds 时输入框为空', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    const input = w.find('#ns-cwd');
    expect((input.element as HTMLInputElement).value).toBe('');
  });

  it('工作目录为空时"新建"按钮禁用', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    const btn = w.find('.act-btn.primary');
    expect((btn.element as HTMLButtonElement).disabled).toBe(true);
  });

  it('工作目录非空时"新建"按钮可用', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds }, global });
    const btn = w.find('.act-btn.primary');
    expect((btn.element as HTMLButtonElement).disabled).toBe(false);
  });

  it('输入路径后点击"新建"发出 create 事件，带正确的 cwd', async () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    await w.find('#ns-cwd').setValue('/Users/test/myproject');
    await w.find('.act-btn.primary').trigger('click');
    expect(w.emitted('create')).toBeTruthy();
    const payload = w.emitted('create')![0]![0] as { cwd: string; title?: string };
    expect(payload.cwd).toBe('/Users/test/myproject');
  });

  it('可选标题不为空时 create 事件携带 title', async () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    await w.find('#ns-cwd').setValue('/Users/test/myproject');
    await w.find('#ns-title').setValue('My Session');
    await w.find('.act-btn.primary').trigger('click');
    const payload = w.emitted('create')![0]![0] as { cwd: string; title?: string };
    expect(payload.title).toBe('My Session');
  });

  it('标题为空时 create 事件不携带 title 字段', async () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    await w.find('#ns-cwd').setValue('/Users/test/myproject');
    await w.find('.act-btn.primary').trigger('click');
    const payload = w.emitted('create')![0]![0] as { cwd: string; title?: string };
    expect(payload.title).toBeUndefined();
  });

  it('点击"最近目录"快速选项填充输入框', async () => {
    const w = mount(NewSessionDialog, { props: { recentCwds }, global });
    // Click the second recent entry
    const items = w.findAll('.recent-item');
    await items[1]!.trigger('click');
    const input = w.find('#ns-cwd');
    expect((input.element as HTMLInputElement).value).toBe(recentCwds[1]);
  });

  it('recentCwds 为空时隐藏"最近目录"区域', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    expect(w.find('.recent-section').exists()).toBe(false);
  });

  it('recentCwds 非空时显示"最近目录"区域', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds }, global });
    expect(w.find('.recent-section').exists()).toBe(true);
    expect(w.findAll('.recent-item')).toHaveLength(recentCwds.length);
  });

  it('点击"取消"发出 close 事件', async () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    const cancelBtn = w.findAll('.act-btn').find((b) => b.text().includes('Cancel'));
    await cancelBtn!.trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('点击关闭按钮 (X) 发出 close 事件', async () => {
    const w = mount(NewSessionDialog, { props: { recentCwds: [] }, global });
    await w.find('.close-btn').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('当前选中的 recent 条目有 is-active 样式', () => {
    const w = mount(NewSessionDialog, { props: { recentCwds }, global });
    // First item should be active since it was pre-filled
    const firstItem = w.findAll('.recent-item')[0]!;
    expect(firstItem.classes()).toContain('is-active');
  });
});
