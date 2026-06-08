// apps/kimi-web/src/composables/__tests__/useResizable.test.ts
import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defineComponent } from 'vue';
import { useResizable, type UseResizable } from '../useResizable';

const KEY = 'kimi-web.sidebar-width';

// useResizable calls onBeforeUnmount, so it must run inside a component setup.
// This harness exposes the hook return so tests can drive it directly.
function makeHarness() {
  let api!: UseResizable;
  const Comp = defineComponent({
    setup() {
      api = useResizable({ storageKey: KEY, defaultWidth: 196, min: 170, max: 420 });
      return () => null;
    },
  });
  const wrapper = mount(Comp);
  return { api, wrapper };
}

describe('useResizable', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => localStorage.clear());

  it('defaults to defaultWidth when nothing stored', () => {
    const { api } = makeHarness();
    expect(api.width.value).toBe(196);
  });

  it('restores a previously persisted width on init', () => {
    localStorage.setItem(KEY, '300');
    const { api } = makeHarness();
    expect(api.width.value).toBe(300);
  });

  it('clamps a stored value above max down to max on init', () => {
    localStorage.setItem(KEY, '9999');
    const { api } = makeHarness();
    expect(api.width.value).toBe(420);
  });

  it('clamp() bounds values to [min, max]', () => {
    const { api } = makeHarness();
    expect(api.clamp(10)).toBe(170);
    expect(api.clamp(250)).toBe(250);
    expect(api.clamp(1000)).toBe(420);
  });

  it('setWidth clamps below min and persists to localStorage', () => {
    const { api } = makeHarness();
    api.setWidth(50);
    expect(api.width.value).toBe(170);
    expect(localStorage.getItem(KEY)).toBe('170');
  });

  it('setWidth clamps above max and persists to localStorage', () => {
    const { api } = makeHarness();
    api.setWidth(800);
    expect(api.width.value).toBe(420);
    expect(localStorage.getItem(KEY)).toBe('420');
  });

  it('setWidth persists an in-range value', () => {
    const { api } = makeHarness();
    api.setWidth(260);
    expect(api.width.value).toBe(260);
    expect(localStorage.getItem(KEY)).toBe('260');
  });

  it('falls back to defaultWidth for a non-numeric stored value', () => {
    localStorage.setItem(KEY, 'not-a-number');
    const { api } = makeHarness();
    expect(api.width.value).toBe(196);
  });
});
