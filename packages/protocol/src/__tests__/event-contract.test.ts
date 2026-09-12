import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { agentEventSchema, VOLATILE_EVENT_TYPES } from '../events';

interface WsEventContract {
  protocolEvents: string[];
  volatileEvents: string[];
}

const contract = JSON.parse(
  readFileSync(
    fileURLToPath(
      new URL('../../../kimi-agent/ws-event-contract.json', import.meta.url),
    ),
    'utf8',
  ),
) as WsEventContract;

interface LiteralOption {
  shape: { type: { value: string } };
}

describe('WS event vocabulary contract (protocol side)', () => {
  it('agentEventSchema matches the golden protocol event set', () => {
    const options = (agentEventSchema as unknown as { options: LiteralOption[] }).options;
    const actual = options.map((option) => option.shape.type.value);
    expect([...actual].sort()).toEqual([...contract.protocolEvents].sort());
  });

  it('VOLATILE_EVENT_TYPES matches the golden volatile set', () => {
    expect([...VOLATILE_EVENT_TYPES].sort()).toEqual([...contract.volatileEvents].sort());
  });
});
