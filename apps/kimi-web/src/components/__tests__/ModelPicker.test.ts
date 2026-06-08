// apps/kimi-web/src/components/__tests__/ModelPicker.test.ts
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ModelPicker from '../ModelPicker.vue';
import type { AppModel } from '../../api/types';

// ModelPicker uses vue-i18n; default locale is English in the test env.
const global = { plugins: [i18n] };

const models: AppModel[] = [
  {
    id: 'moonshot-v1-128k',
    provider: 'prov_moonshot',
    model: 'moonshot-v1-128k',
    displayName: 'Moonshot 128K',
    maxContextSize: 131072,
    capabilities: [],
  },
  {
    id: 'moonshot-v1-32k',
    provider: 'prov_moonshot',
    model: 'moonshot-v1-32k',
    displayName: 'Moonshot 32K',
    maxContextSize: 32768,
    capabilities: [],
  },
  {
    id: 'claude-sonnet-4-6',
    provider: 'prov_anthropic',
    model: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    maxContextSize: 200000,
    capabilities: ['thinking'],
  },
];

describe('ModelPicker', () => {
  it('显示所有模型', () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    const text = w.text();
    expect(text).toContain('Moonshot 128K');
    expect(text).toContain('Moonshot 32K');
    expect(text).toContain('Claude Sonnet 4.6');
  });

  it('当前模型显示 ✓ 标记', () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    // The current model row has is-current class and shows check mark
    const currentRow = w.findAll('.model-row').find((r) => r.classes('is-current'));
    expect(currentRow).toBeTruthy();
    expect(currentRow!.text()).toContain('✓');
  });

  it('点击模型行发出 select 事件', async () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    // Click the second model row (Moonshot 32K)
    const rows = w.findAll('.model-row');
    expect(rows.length).toBeGreaterThan(1);
    await rows[1]!.trigger('click');
    expect(w.emitted('select')).toBeTruthy();
    expect(w.emitted('select')![0]).toEqual(['moonshot-v1-32k']);
  });

  it('搜索过滤只显示匹配模型', async () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    const input = w.get('.search-input');
    await input.setValue('anthropic');
    const rows = w.findAll('.model-row');
    // Only Claude Sonnet (anthropic provider) should be visible
    expect(rows.length).toBe(1);
    expect(rows[0]!.text()).toContain('Claude Sonnet 4.6');
  });

  it('搜索无结果时显示"无匹配模型"提示', async () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    const input = w.get('.search-input');
    await input.setValue('zzzzzzznonexistent');
    expect(w.text()).toContain('No matching models');
  });

  it('点击关闭按钮发出 close 事件', async () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    await w.get('.close-btn').trigger('click');
    expect(w.emitted('close')).toBeTruthy();
  });

  it('模型按提供商分组显示 group-label', () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    const labels = w.findAll('.group-label');
    expect(labels.length).toBe(2); // prov_moonshot + prov_anthropic
  });

  it('capabilities 标签显示', () => {
    const w = mount(ModelPicker, {
      props: { models, current: 'moonshot-v1-128k' },
      global,
    });
    // Claude has 'thinking' capability
    expect(w.text()).toContain('thinking');
  });
});
