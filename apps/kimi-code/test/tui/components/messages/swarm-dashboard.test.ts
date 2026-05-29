import { describe, expect, it } from 'vitest';

import { SwarmDashboardComponent } from '#/tui/components/messages/swarm-dashboard';
import { darkColors } from '#/tui/theme/colors';

const ESC = String.fromCodePoint(0x1b);
function strip(text: string): string {
  return text.replaceAll(/\[[0-9;]*m/g, '').replaceAll(new RegExp(`${ESC}\\][0-9];;[^\\u0007]*\\u0007`, 'g'), '');
}

describe('SwarmDashboardComponent', () => {
  it('renders phase header and worker rows', () => {
    const c = new SwarmDashboardComponent('compare error handling', darkColors, undefined);
    c.apply({ t: 'planned', total: 2 });
    c.apply({ t: 'worker.spawned', id: 'a1', role: 'Researcher' });
    c.apply({ t: 'worker.toolcall', id: 'a1', activity: 'read foo.ts' });
    c.apply({ t: 'worker.spawned', id: 'a2', role: 'Analyst' });
    c.apply({ t: 'worker.done', id: 'a2', tokens: 1800 });

    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('Swarm');
    expect(out).toContain('compare error handling');
    expect(out).toContain('Researcher');
    expect(out).toContain('read foo.ts');
    expect(out).toContain('Analyst');
  });

  it('shows a failed worker with its error', () => {
    const c = new SwarmDashboardComponent('t', darkColors, undefined);
    c.apply({ t: 'planned', total: 1 });
    c.apply({ t: 'worker.spawned', id: 'a1', role: 'Scan' });
    c.apply({ t: 'worker.failed', id: 'a1', error: 'timeout' });
    const out = strip(c.render(80).join('\n'));
    expect(out).toContain('Scan');
    expect(out).toContain('timeout');
  });

  it('finalizes to a summary header on done', () => {
    const c = new SwarmDashboardComponent('t', darkColors, undefined);
    c.apply({ t: 'planned', total: 2 });
    c.apply({ t: 'worker.spawned', id: 'a1', role: 'R' });
    c.apply({ t: 'worker.done', id: 'a1' });
    c.apply({ t: 'worker.spawned', id: 'a2', role: 'A' });
    c.apply({ t: 'worker.failed', id: 'a2', error: 'x' });
    c.apply({ t: 'done', succeeded: 1, failed: 1 });
    const out = strip(c.render(80).join('\n'));
    expect(out).toMatch(/2 workers/);
    expect(out).toContain('1');
  });
});
