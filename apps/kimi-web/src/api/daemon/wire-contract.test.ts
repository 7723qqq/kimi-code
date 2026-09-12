import { describe, expect, it } from 'vitest';

import contract from '../../../../../packages/kimi-agent/ws-event-contract.json';
import { WIRE_EVENT_TYPES } from './wire';

describe('WS event vocabulary contract (kimi-web side)', () => {
  it('WIRE_EVENT_TYPES matches the golden web event set', () => {
    expect([...WIRE_EVENT_TYPES].sort()).toEqual([...contract.webEvents].sort());
  });

  it('every server-emitted event is part of the client vocabulary', () => {
    for (const name of contract.serverEvents) {
      expect(contract.webEvents).toContain(name);
    }
  });
});
