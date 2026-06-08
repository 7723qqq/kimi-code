// apps/kimi-web/src/components/__tests__/AddWorkspaceDialog.test.ts
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import AddWorkspaceDialog from '../AddWorkspaceDialog.vue';
import type { FsBrowseResult } from '../../api/types';

const global = { plugins: [i18n] };

// A tiny two-level folder tree for the browser.
const TREE: Record<string, FsBrowseResult> = {
  '/Users/me': {
    path: '/Users/me',
    parent: '/Users',
    entries: [
      { name: 'code', path: '/Users/me/code', isDir: true, isGitRepo: false },
      { name: 'Documents', path: '/Users/me/Documents', isDir: true, isGitRepo: false },
    ],
  },
  '/Users/me/code': {
    path: '/Users/me/code',
    parent: '/Users/me',
    entries: [
      { name: 'proj', path: '/Users/me/code/proj', isDir: true, isGitRepo: true, branch: 'main' },
    ],
  },
};

function makeProps(over: Partial<{ browseFs: (p?: string) => Promise<FsBrowseResult> }> = {}) {
  const browseFs = over.browseFs
    ?? vi.fn(async (p?: string) => TREE[p ?? '/Users/me'] ?? { path: p ?? '', parent: null, entries: [] });
  const getFsHome = vi.fn(async () => ({ home: '/Users/me', recentRoots: ['/Users/me/code/proj'] }));
  return { recentRoots: [], browseFs, getFsHome };
}

describe('AddWorkspaceDialog — folder browser', () => {
  it('打开时从 fs:home 起步并渲染 fs:browse 的子文件夹', async () => {
    const w = mount(AddWorkspaceDialog, { props: makeProps(), global });
    await flushPromises();
    const rows = w.findAll('.folder-row');
    expect(rows).toHaveLength(2);
    expect(w.text()).toContain('code');
    expect(w.text()).toContain('Documents');
    // Breadcrumb reflects the current path.
    expect(w.find('.crumb.last').text()).toBe('me');
  });

  it('点击文件夹导航进入并渲染该目录的子文件夹（含 git 标签）', async () => {
    const w = mount(AddWorkspaceDialog, { props: makeProps(), global });
    await flushPromises();
    const codeRow = w.findAll('.folder-row').find((r) => r.text().includes('code'));
    await codeRow!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('proj');
    // git repo gets a git tag with branch.
    expect(w.find('.git-tag').exists()).toBe(true);
    expect(w.find('.git-tag').text()).toContain('git');
    expect(w.find('.git-tag').text()).toContain('main');
  });

  it('"打开此文件夹"用当前已浏览路径发出 add 事件', async () => {
    const w = mount(AddWorkspaceDialog, { props: makeProps(), global });
    await flushPromises();
    // Navigate into /Users/me/code first.
    const codeRow = w.findAll('.folder-row').find((r) => r.text().includes('code'));
    await codeRow!.trigger('click');
    await flushPromises();
    await w.find('.act-btn.primary').trigger('click');
    expect(w.emitted('add')).toBeTruthy();
    expect(w.emitted('add')![0]).toEqual(['/Users/me/code']);
  });

  it('recent roots 渲染为快捷 chip', async () => {
    const w = mount(AddWorkspaceDialog, { props: makeProps(), global });
    await flushPromises();
    const chips = w.findAll('.recent-chip');
    expect(chips.length).toBe(1);
    expect(chips[0]!.text()).toContain('/Users/me/code/proj');
  });

  it('browseFs 失败时退化为粘贴路径输入', async () => {
    const browseFs = vi.fn(async () => ({ path: '', parent: null, entries: [] }));
    const w = mount(AddWorkspaceDialog, { props: makeProps({ browseFs }), global });
    await flushPromises();
    // No folder list; paste input is available.
    expect(w.find('.folder-list').exists()).toBe(false);
    const input = w.find('.paste-input');
    expect(input.exists()).toBe(true);
    await input.setValue('/Users/me/typed');
    await w.find('.paste-add').trigger('click');
    expect(w.emitted('add')![0]).toEqual(['/Users/me/typed']);
  });
});
