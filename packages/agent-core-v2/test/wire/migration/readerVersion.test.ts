import { describe, expect, it } from 'bun:test';

import { assertWireReaderVersion, WIRE_PROTOCOL_VERSION } from '#/wire/migration/migration';

describe('assertWireReaderVersion', () => {
  it('keeps protocol versions out of the message and reports them as details', () => {
    let thrown: unknown;
    try {
      assertWireReaderVersion('9.9');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toMatchObject({
      code: 'wire.version_too_low',
      message:
        'This session requires a newer version of Kimi Code. Upgrade Kimi Code to the latest version to read this session.',
      details: {
        minReaderVersion: '9.9',
        readerVersion: WIRE_PROTOCOL_VERSION,
      },
    });
  });

  it('accepts a requirement the current reader already meets', () => {
    expect(() => assertWireReaderVersion(WIRE_PROTOCOL_VERSION)).not.toThrow();
    expect(() => assertWireReaderVersion(undefined)).not.toThrow();
  });
});
