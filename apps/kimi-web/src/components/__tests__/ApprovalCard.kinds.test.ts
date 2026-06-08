import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import ApprovalCard from '../ApprovalCard.vue';
import i18n from '../../i18n';
import type { ApprovalBlock } from '../../types';

// ApprovalCard uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

// ---------------------------------------------------------------------------
// shell block
// ---------------------------------------------------------------------------

const shellBlock: ApprovalBlock = {
  kind: 'shell',
  command: 'pnpm test --run',
  cwd: '/repo',
  danger: 'modifies filesystem',
};

describe('ApprovalCard — shell block', () => {
  it('renders $ command in mono block', () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    const t = w.text();
    expect(t).toContain('$');
    expect(t).toContain('pnpm test --run');
  });

  it('renders dim cwd line', () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    expect(w.text()).toContain('cwd: /repo');
  });

  it('renders danger box', () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    expect(w.text()).toContain('Danger: modifies filesystem');
    expect(w.find('.shell-danger').exists()).toBe(true);
  });

  it('shows title 运行命令?', () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    expect(w.text()).toContain('Run command?');
  });

  it('emits decide {decision:approved} on 批准 click', async () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    await w.findAll('.kbtn')[0]!.trigger('click');
    expect(w.emitted('decide')).toBeTruthy();
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'approved' }]);
  });

  it('emits decide {decision:approved, scope:session} on 本会话内批准 click', async () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    await w.findAll('.kbtn')[1]!.trigger('click');
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'approved', scope: 'session' }]);
  });

  it('emits decide {decision:rejected} on 拒绝 click', async () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    await w.findAll('.kbtn')[2]!.trigger('click');
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'rejected' }]);
  });

  it('＋反馈 button opens feedback textarea', async () => {
    const w = mount(ApprovalCard, { props: { block: shellBlock }, global });
    expect(w.find('textarea').exists()).toBe(false);
    await w.findAll('.kbtn')[3]!.trigger('click');
    expect(w.find('textarea').exists()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// generic block
// ---------------------------------------------------------------------------

const genericBlock: ApprovalBlock = {
  kind: 'generic',
  summary: '执行危险操作 XYZ',
};

describe('ApprovalCard — generic block', () => {
  it('shows title 批准操作?', () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock }, global });
    expect(w.text()).toContain('Approve action?');
  });

  it('renders summary text', () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock }, global });
    expect(w.text()).toContain('执行危险操作 XYZ');
  });

  it('shows four action buttons', () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock }, global });
    const btns = w.findAll('.kbtn');
    expect(btns).toHaveLength(4);
    const t = w.text();
    expect(t).toContain('Approve');
    expect(t).toContain('Approve for session');
    expect(t).toContain('Reject');
    expect(t).toContain('Feedback');
  });

  it('emits decide {decision:approved} on 批准 click', async () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock }, global });
    await w.findAll('.kbtn')[0]!.trigger('click');
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'approved' }]);
  });

  it('emits decide {decision:rejected} on 拒绝 click', async () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock }, global });
    await w.findAll('.kbtn')[2]!.trigger('click');
    expect(w.emitted('decide')![0]).toEqual([{ decision: 'rejected' }]);
  });
});

// ---------------------------------------------------------------------------
// diff block (existing tests keep working)
// ---------------------------------------------------------------------------

const diffBlock: ApprovalBlock = {
  kind: 'diff',
  path: 'src/api/client.ts',
  diff: [
    { kind: 'rem', gutter: '23', text: '- const timeout = 5000;' },
    { kind: 'add', gutter: '23', text: '+ const timeout = opts.timeoutMs ?? 5000;' },
  ],
};

describe('ApprovalCard — diff block', () => {
  it('renders path and diff lines', () => {
    const w = mount(ApprovalCard, { props: { block: diffBlock }, global });
    const t = w.text();
    expect(t).toContain('src/api/client.ts');
    expect(t).toContain('opts.timeoutMs ?? 5000');
  });

  it('del/add lines have correct classes', () => {
    const w = mount(ApprovalCard, { props: { block: diffBlock }, global });
    expect(w.findAll('.del')).toHaveLength(1);
    expect(w.findAll('.add')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// agentName badge
// ---------------------------------------------------------------------------

describe('ApprovalCard — agentName badge', () => {
  it('renders subagent badge when agentName provided', () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock, agentName: 'test-subagent' }, global });
    expect(w.find('.abadge').exists()).toBe(true);
    expect(w.text()).toContain('subagent · test-subagent');
  });

  it('no badge when agentName not provided', () => {
    const w = mount(ApprovalCard, { props: { block: genericBlock }, global });
    expect(w.find('.abadge').exists()).toBe(false);
  });
});
