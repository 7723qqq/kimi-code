import { describe, expect, it } from 'vitest';
import { StatusSurfaceComponent } from '#/tui/components/chrome/status-surface/index';
import { UpdatesRegion } from '#/tui/components/chrome/status-surface/regions/updates-region';
import { NotifyPanelComponent } from '#/tui/components/chrome/notify-panel';

describe('b4', () => {
  it('trace', () => {
    const surface = new StatusSurfaceComponent({ terminalRows: () => 40 });
    const np = new NotifyPanelComponent(() => 40);
    const region = new UpdatesRegion(np);
    surface.setRegion(region);
    for (let i = 1; i <= 3; i++) np.upsert({ id: String(i), agentId: 'main', time: i, text: `u${i}` });
    surface.render(80);
    console.log('focusRegion ->', surface.focusRegion('updates'), 'focused=', surface.focusedRegion());
    console.log('panel.isFocused', region.isFocused());
    console.log('region.handleKey(pageUp)', region.handleKey('pageUp'));
    console.log('surface.handleKey(pageUp)', surface.handleKey('pageUp'));
    expect(1).toBe(1);
  });
});
