import { describe, expect, it } from 'vitest';

import { ConsoleSink } from '#/telemetry/consoleSink';

describe('ConsoleSink', () => {
  it('logs event name and properties with the default prefix', () => {
    const lines: string[] = [];
    const sink = new ConsoleSink({ log: (message) => lines.push(message) });
    sink.track('tool.call', { name: 'bash', count: 1 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[telemetry] tool.call');
    expect(lines[0]).toContain('"name":"bash"');
    expect(lines[0]).toContain('"count":1');
  });

  it('uses a custom prefix', () => {
    const lines: string[] = [];
    const sink = new ConsoleSink({ prefix: '[dbg]', log: (message) => lines.push(message) });
    sink.track('evt');
    expect(lines[0]).toBe('[dbg] evt');
  });

  it('omits the payload when properties is undefined', () => {
    const lines: string[] = [];
    const sink = new ConsoleSink({ log: (message) => lines.push(message) });
    sink.track('evt');
    expect(lines[0]).toBe('[telemetry] evt');
  });

  it('pretty-prints properties when requested', () => {
    const lines: string[] = [];
    const sink = new ConsoleSink({ pretty: true, log: (message) => lines.push(message) });
    sink.track('evt', { a: 1 });
    expect(lines[0]).toContain('\n');
  });
});
