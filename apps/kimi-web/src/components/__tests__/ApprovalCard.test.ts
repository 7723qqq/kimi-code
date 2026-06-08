import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ApprovalCard from '../ApprovalCard.vue';
import i18n from '../../i18n';
import type { ApprovalBlock } from '../../types';

// ApprovalCard uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

const block: ApprovalBlock = {
  kind: 'diff',
  path: 'src/api/client.ts',
  diff: [
    { kind: 'rem', gutter: '23', text: '- const timeout = 5000;' },
    { kind: 'add', gutter: '23', text: '+ const timeout = opts.timeoutMs ?? 5000;' },
  ],
};

describe('ApprovalCard', () => {
  it('显示文件路径、diff 行、四个操作', () => {
    const w = mount(ApprovalCard, { props: { block }, global });
    const t = w.text();
    expect(t).toContain('src/api/client.ts');
    expect(t).toContain('opts.timeoutMs ?? 5000');
    expect(t).toContain('Approve');
    expect(t).toContain('Approve for session');
    expect(t).toContain('Reject');
    expect(t).toContain('Feedback');
  });

  it('增/删行带对应 class', () => {
    const w = mount(ApprovalCard, { props: { block }, global });
    expect(w.findAll('.del')).toHaveLength(1);
    expect(w.findAll('.add')).toHaveLength(1);
  });

  it('点击批准按钮发出 decide 事件（decision: approved）', async () => {
    const w = mount(ApprovalCard, { props: { block }, global });
    // First .kbtn is Approve (primary)
    await w.findAll('.kbtn')[0]!.trigger('click');
    expect(w.emitted('decide')).toBeTruthy();
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'approved' }]);
  });

  it('点击拒绝按钮发出 decide 事件（decision: rejected）', async () => {
    const w = mount(ApprovalCard, { props: { block }, global });
    // Third .kbtn is Reject
    await w.findAll('.kbtn')[2]!.trigger('click');
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'rejected' }]);
  });
});
