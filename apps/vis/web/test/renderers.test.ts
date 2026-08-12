import { describe, expect, it } from 'vitest';

import { recordTypeOf } from '../src/components/wire/renderers';

describe('recordTypeOf — runtime discriminator for wire records', () => {
  it('returns the legacy `type` discriminator when present', () => {
    expect(recordTypeOf({ type: 'turn.prompt', time: 1 })).toBe('turn.prompt');
    expect(recordTypeOf({ type: 'context.append_loop_event', event: {} })).toBe(
      'context.append_loop_event',
    );
  });

  it('falls back to `record_type` for SQLite projection shapes', () => {
    expect(recordTypeOf({ record_type: 'tool_call', name: 'Bash' })).toBe('tool_call');
    expect(recordTypeOf({ record_type: 'step_end', reason: 'ok' })).toBe('step_end');
  });

  it('prefers the legacy `type` over `record_type` when both are present', () => {
    expect(recordTypeOf({ type: 'turn.prompt', record_type: 'prompt' })).toBe('turn.prompt');
  });

  it('returns `unknown` for non-objects and missing discriminators', () => {
    expect(recordTypeOf(null)).toBe('unknown');
    expect(recordTypeOf(undefined)).toBe('unknown');
    expect(recordTypeOf('x')).toBe('unknown');
    expect(recordTypeOf(42)).toBe('unknown');
    expect(recordTypeOf({})).toBe('unknown');
    expect(recordTypeOf({ type: 42 })).toBe('unknown');
    expect(recordTypeOf({ record_type: 42 })).toBe('unknown');
  });
});
