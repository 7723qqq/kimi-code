// apps/kimi-web/test/pane-layout-preview.test.ts
//
// The preview pane is a transient view that lives at the same level as
// chat/files: opening it splits the layout (like the split button); closing it
// collapses the split back.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { usePaneLayout, type PaneLayout, type PaneGroup } from '../src/composables/usePaneLayout';

function groups(node: PaneLayout): PaneGroup[] {
  return node.type === 'group' ? [node] : node.children.flatMap(groups);
}

beforeEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => {
  try { localStorage.clear(); } catch { /* ignore */ }
});

describe('usePaneLayout preview pane', () => {
  it('opens the preview as a split peer and closes back to one group', () => {
    const pl = usePaneLayout();
    // Default: a single chat group.
    expect(pl.layout.value.type).toBe('group');

    pl.openPreview();
    // Now a split with a dedicated preview group alongside the original.
    expect(pl.layout.value.type).toBe('split');
    const previewGroups = groups(pl.layout.value).filter((g) => g.views.includes('preview'));
    expect(previewGroups).toHaveLength(1);
    expect(previewGroups[0]!.active).toBe('preview');

    pl.closePreview();
    // Collapses back to a single (non-preview) group.
    expect(pl.layout.value.type).toBe('group');
    expect(groups(pl.layout.value).some((g) => g.views.includes('preview'))).toBe(false);
  });

  it('focuses the existing preview group instead of splitting again', () => {
    const pl = usePaneLayout();
    pl.openPreview();
    const afterFirst = JSON.parse(JSON.stringify(pl.layout.value));
    pl.openPreview();
    // No new split — still exactly one preview group.
    expect(groups(pl.layout.value).filter((g) => g.views.includes('preview'))).toHaveLength(1);
    // Same split structure (id unchanged).
    expect((pl.layout.value as { id: string }).id).toBe(afterFirst.id);
  });

  it('keeps a preview split group when the user switches it to another tab', () => {
    const pl = usePaneLayout();
    pl.openPreview();

    const previewGroup = groups(pl.layout.value).find((g) => g.views.includes('preview'));
    expect(previewGroup).toBeDefined();

    pl.setActive(previewGroup!.id, 'files');
    pl.closePreview();

    const remainingGroups = groups(pl.layout.value);
    expect(remainingGroups).toHaveLength(2);
    expect(remainingGroups.some((g) => g.views.includes('preview'))).toBe(false);
    expect(remainingGroups.some((g) => g.active === 'files')).toBe(true);
  });
});
