// apps/kimi-web/src/components/__tests__/TasksPane.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import TasksPane from '../TasksPane.vue';
import i18n from '../../i18n';
import type { TaskItem } from '../../types';

// TasksPane uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

const tasks: TaskItem[] = [
  { id: 'k1', name: 'build docs', kind: 'subagent', state: 'run', timing: '运行中 · 0:12', meta: '$ build' },
  { id: 'k3', name: 'lint', kind: 'task', state: 'done', timing: '完成 · 0.6s', output: ['$ eslint', '✓ 0'] },
];

describe('TasksPane', () => {
  it('渲染每个任务的名称与计时', () => {
    const w = mount(TasksPane, { props: { tasks }, global });
    expect(w.text()).toContain('build docs');
    expect(w.text()).toContain('运行中 · 0:12');
    expect(w.text()).toContain('lint');
  });

  it('运行中的任务显示停止按钮，完成的不显示', () => {
    const w = mount(TasksPane, { props: { tasks }, global });
    expect(w.findAll('.stop')).toHaveLength(1);
  });

  it('运行/完成状态点带对应 class', () => {
    const w = mount(TasksPane, { props: { tasks }, global });
    expect(w.findAll('.tdot.run')).toHaveLength(1);
    expect(w.findAll('.tdot.done')).toHaveLength(1);
  });

  it('点击停止按钮发出 cancel 事件并带任务 id', async () => {
    const w = mount(TasksPane, { props: { tasks }, global });
    await w.find('.stop').trigger('click');
    expect(w.emitted('cancel')).toBeTruthy();
    expect(w.emitted('cancel')![0]).toEqual(['k1']);
  });
});
