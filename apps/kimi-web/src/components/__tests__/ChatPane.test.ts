// apps/kimi-web/src/components/__tests__/ChatPane.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ChatPane from '../ChatPane.vue';
import type { ChatTurn, ApprovalBlock } from '../../types';

// ChatPane (and child components) use vue-i18n; default locale is English.
const global = { plugins: [i18n] };

const turns: ChatTurn[] = [
  { id: 't1', role: 'user', no: 1, text: '你好' },
  {
    id: 't2', role: 'assistant', no: 2, text: '执行中',
    tools: [{ id: 'x', name: 'read', arg: '· a.ts', status: 'ok', timing: '5ms' }],
  },
];

const approvals: { approvalId: string; block: ApprovalBlock }[] = [
  { approvalId: 'apr_1', block: { kind: 'diff', path: 'a.ts', diff: [{ kind: 'add', gutter: '1', text: '+ x' }] } },
];

describe('ChatPane', () => {
  it('渲染用户与助手发言、工具卡', () => {
    const w = mount(ChatPane, { props: { turns }, global });
    expect(w.text()).toContain('你好');
    expect(w.text()).toContain('执行中');
    expect(w.findComponent({ name: 'ToolCall' }).exists()).toBe(true);
  });

  it('渲染待批准的独立 interrupt 卡片', () => {
    const w = mount(ChatPane, { props: { turns, approvals }, global });
    expect(w.findComponent({ name: 'ApprovalCard' }).exists()).toBe(true);
  });
});
