import { describe, expect, it } from '@moonshot-ai/testkit/vitest';
import { dockHeightPx, publishDockHeightPx } from '../src/lib/dockMetrics';

describe('dockHeightPx', () => {
  it('starts unknown and reflects the last published height', () => {
    expect(dockHeightPx.value).toBeNull();
    publishDockHeightPx(96);
    expect(dockHeightPx.value).toBe(96);
    publishDockHeightPx(120);
    expect(dockHeightPx.value).toBe(120);
  });
});
