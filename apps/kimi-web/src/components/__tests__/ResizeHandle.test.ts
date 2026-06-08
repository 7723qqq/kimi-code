// apps/kimi-web/src/components/__tests__/ResizeHandle.test.ts
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import i18n from '../../i18n';
import ResizeHandle from '../ResizeHandle.vue';

const KEY = 'kimi-web.sidebar-width';
const global = { plugins: [i18n] };

const props = { storageKey: KEY, defaultWidth: 196, min: 170, max: 420 };

describe('ResizeHandle', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('renders a separator with an aria-label and col-resize affordance', () => {
    const w = mount(ResizeHandle, { props, global });
    const el = w.find('.rh');
    expect(el.exists()).toBe(true);
    expect(el.attributes('role')).toBe('separator');
    expect(el.attributes('aria-label')).toBeTruthy();
  });

  it('emits update:width with the default width on mount', () => {
    const w = mount(ResizeHandle, { props, global });
    expect(w.emitted('update:width')?.[0]).toEqual([196]);
  });

  it('restores and emits a persisted width (clamped) on mount', () => {
    localStorage.setItem(KEY, '9999');
    const w = mount(ResizeHandle, { props, global });
    // clamped down to max
    expect(w.emitted('update:width')?.[0]).toEqual([420]);
  });

  it('updates width and persists when dragged via pointer events', async () => {
    localStorage.setItem(KEY, '200');
    const w = mount(ResizeHandle, { props, global });
    const el = w.find('.rh');
    await el.trigger('pointerdown', { clientX: 100, pointerId: 1 });
    // pointermove listeners are attached to the element itself
    el.element.dispatchEvent(new Event('pointermove'));
    // simulate a real move with clientX delta of +40 → 240
    el.element.dispatchEvent(
      Object.assign(new Event('pointermove'), { clientX: 140, pointerId: 1 }),
    );
    await w.vm.$nextTick();
    const emits = w.emitted('update:width')!;
    expect(emits[emits.length - 1]).toEqual([240]);
    expect(localStorage.getItem(KEY)).toBe('240');
  });
});
