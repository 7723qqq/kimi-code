// apps/kimi-web/src/components/__tests__/DiffView.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import DiffView from '../DiffView.vue';

// DiffView uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

const gitInfo = { branch: 'feat/web', ahead: 1, behind: 50 };

const changes = [
  { path: 'apps/kimi-code/package.json', status: 'modified' },
  { path: 'packages/daemon/src/middleware/schema.ts', status: 'added' },
  { path: 'packages/old-file.ts', status: 'deleted' },
];

describe('DiffView (ChangesView)', () => {
  it('显示分支名和改动数', () => {
    const w = mount(DiffView, { props: { changes, gitInfo }, global });
    expect(w.text()).toContain('feat/web');
    expect(w.text()).toContain('3 changes');
  });

  it('每个改动文件都显示路径和状态徽章', () => {
    const w = mount(DiffView, { props: { changes, gitInfo }, global });
    const rows = w.findAll('.ch-row');
    expect(rows).toHaveLength(3);
    expect(w.text()).toContain('package.json');
    expect(w.text()).toContain('schema.ts');
  });

  it('modified → M 徽章', () => {
    const w = mount(DiffView, { props: { changes, gitInfo }, global });
    const badges = w.findAll('.badge');
    const modBadge = badges.find((b) => b.text() === 'M');
    expect(modBadge).toBeTruthy();
    expect(modBadge!.classes()).toContain('modified');
  });

  it('added → A 徽章', () => {
    const w = mount(DiffView, { props: { changes, gitInfo }, global });
    const badges = w.findAll('.badge');
    const addBadge = badges.find((b) => b.text() === 'A');
    expect(addBadge).toBeTruthy();
    expect(addBadge!.classes()).toContain('added');
  });

  it('deleted → D 徽章', () => {
    const w = mount(DiffView, { props: { changes, gitInfo }, global });
    const badges = w.findAll('.badge');
    const delBadge = badges.find((b) => b.text() === 'D');
    expect(delBadge).toBeTruthy();
    expect(delBadge!.classes()).toContain('deleted');
  });

  it('无 git 信息时显示空状态文字', () => {
    const w = mount(DiffView, { props: { changes: [], gitInfo: null }, global });
    expect(w.text()).toContain('No git changes');
  });

  it('有 git 信息但无改动时显示"工作区干净"', () => {
    const w = mount(DiffView, { props: { changes: [], gitInfo }, global });
    expect(w.text()).toContain('Working tree clean');
  });

  it('显示 ahead/behind 同步信息', () => {
    const w = mount(DiffView, { props: { changes, gitInfo }, global });
    // ahead=1, behind=50
    expect(w.find('.ahead').exists()).toBe(true);
    expect(w.find('.behind').exists()).toBe(true);
  });
});
