// apps/kimi-web/src/components/__tests__/FileTree.test.ts
import { flushPromises, mount } from '@vue/test-utils';
import { describe, expect, it, vi } from 'vitest';
import i18n from '../../i18n';
import FileTree from '../FileTree.vue';
import type { FsEntry } from '../../api/types';

// FileTree uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const dirEntry = (path: string, name: string): FsEntry => ({
  path, name, kind: 'directory', modifiedAt: '2026-01-01T00:00:00Z',
});

const fileEntry = (path: string, name: string, gitStatus?: string): FsEntry => ({
  path, name, kind: 'file', modifiedAt: '2026-01-01T00:00:00Z',
  ...(gitStatus ? { gitStatus } : {}),
});

const rootEntries: FsEntry[] = [
  dirEntry('src', 'src'),
  fileEntry('README.md', 'README.md'),
  fileEntry('package.json', 'package.json', 'modified'),
];

const srcEntries: FsEntry[] = [
  dirEntry('src/components', 'components'),
  fileEntry('src/main.ts', 'main.ts', 'added'),
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FileTree', () => {
  it('renders root entries on mount', async () => {
    const loadDir = vi.fn().mockResolvedValue(rootEntries);
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    expect(loadDir).toHaveBeenCalledWith('.');
    const rows = w.findAll('.ft-row');
    expect(rows.length).toBe(3);
    expect(w.text()).toContain('src');
    expect(w.text()).toContain('README.md');
    expect(w.text()).toContain('package.json');
  });

  it('sorts directories before files', async () => {
    const loadDir = vi.fn().mockResolvedValue(rootEntries);
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    const rows = w.findAll('.ft-row');
    // First row should be the directory (src)
    expect(rows[0]!.classes()).toContain('directory');
    // Next rows should be files
    expect(rows[1]!.classes()).not.toContain('directory');
  });

  it('shows empty state when loadDir returns []', async () => {
    const loadDir = vi.fn().mockResolvedValue([]);
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    expect(w.text()).toContain('Unable to read workspace files');
    expect(w.findAll('.ft-row')).toHaveLength(0);
  });

  it('shows empty state when loadDir throws', async () => {
    const loadDir = vi.fn().mockRejectedValue(new Error('network error'));
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    expect(w.text()).toContain('Unable to read workspace files');
  });

  it('expands a directory via lazy loadDir call', async () => {
    const loadDir = vi.fn()
      .mockResolvedValueOnce(rootEntries)   // root load
      .mockResolvedValueOnce(srcEntries);   // src/ lazy load

    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    // Click on src directory row
    const dirRow = w.findAll('.ft-row').find((r) => r.classes().includes('directory'));
    expect(dirRow).toBeDefined();
    await dirRow!.trigger('click');
    await flushPromises();

    // loadDir should have been called again for src
    expect(loadDir).toHaveBeenCalledWith('src');

    // Children should now be visible
    expect(w.text()).toContain('components');
    expect(w.text()).toContain('main.ts');
  });

  it('collapses a directory on second click without re-fetching', async () => {
    const loadDir = vi.fn()
      .mockResolvedValueOnce(rootEntries)
      .mockResolvedValueOnce(srcEntries);

    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    const dirRow = () => w.findAll('.ft-row').find((r) => r.classes().includes('directory'));

    // Expand
    await dirRow()!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('main.ts');

    // Collapse
    await dirRow()!.trigger('click');
    await flushPromises();
    expect(w.text()).not.toContain('main.ts');

    // Re-expand: should NOT call loadDir again (cached)
    await dirRow()!.trigger('click');
    await flushPromises();
    expect(w.text()).toContain('main.ts');
    expect(loadDir).toHaveBeenCalledTimes(2); // root + first expand only
  });

  it('emits select when a file row is clicked', async () => {
    const loadDir = vi.fn().mockResolvedValue(rootEntries);
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    // Click on README.md row (second row after directory sort)
    const fileRows = w.findAll('.ft-row').filter((r) => !r.classes().includes('directory'));
    await fileRows[0]!.trigger('click');

    const selectEvents = w.emitted('select');
    expect(selectEvents).toBeDefined();
    expect(selectEvents!.length).toBe(1);
    // The emitted entry should be the first file alphabetically
    const emittedEntry = selectEvents![0]![0] as FsEntry;
    expect(emittedEntry.kind).toBe('file');
  });

  it('does not emit select when a directory is clicked', async () => {
    const loadDir = vi.fn()
      .mockResolvedValueOnce(rootEntries)
      .mockResolvedValueOnce([]);

    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    const dirRow = w.findAll('.ft-row').find((r) => r.classes().includes('directory'));
    await dirRow!.trigger('click');
    await flushPromises();

    expect(w.emitted('select')).toBeUndefined();
  });

  it('shows git status badge from changesByPath', async () => {
    const loadDir = vi.fn().mockResolvedValue(rootEntries);
    const w = mount(FileTree, {
      props: {
        loadDir,
        changesByPath: { 'package.json': 'modified', 'README.md': 'added' },
      },
      global,
    });
    await flushPromises();

    const badges = w.findAll('.ft-badge');
    expect(badges.length).toBeGreaterThan(0);
    // modified badge = M
    const mBadge = badges.find((b) => b.text() === 'M');
    expect(mBadge).toBeDefined();
    expect(mBadge!.classes()).toContain('modified');
    // added badge = A
    const aBadge = badges.find((b) => b.text() === 'A');
    expect(aBadge).toBeDefined();
    expect(aBadge!.classes()).toContain('added');
  });

  it('highlights selected file', async () => {
    const loadDir = vi.fn().mockResolvedValue(rootEntries);
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {} },
      global,
    });
    await flushPromises();

    const fileRows = w.findAll('.ft-row').filter((r) => !r.classes().includes('directory'));
    expect(fileRows.length).toBeGreaterThan(0);

    // Before click: no selected row
    expect(w.find('.ft-row.selected').exists()).toBe(false);

    await fileRows[0]!.trigger('click');

    // After click: one selected row
    expect(w.find('.ft-row.selected').exists()).toBe(true);
  });

  it('reloads root when reloadKey changes', async () => {
    const loadDir = vi.fn().mockResolvedValue(rootEntries);
    const w = mount(FileTree, {
      props: { loadDir, changesByPath: {}, reloadKey: 'session-1' },
      global,
    });
    await flushPromises();
    expect(loadDir).toHaveBeenCalledTimes(1);

    await w.setProps({ reloadKey: 'session-2' });
    await flushPromises();
    expect(loadDir).toHaveBeenCalledTimes(2);
  });
});
