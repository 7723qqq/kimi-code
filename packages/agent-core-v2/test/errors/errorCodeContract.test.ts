import { describe, expect, it } from 'bun:test';

import { ERROR_CODE_UNION } from '#/_base/errors/errorCode.generated';
import { ErrorCodes } from '#/errors';

describe('error code union', () => {
  it('matches the runtime aggregate exactly', () => {
    const runtime = [...new Set(Object.values(ErrorCodes))].sort();
    expect([...ERROR_CODE_UNION]).toEqual(runtime);
  });

  it('keeps the generated list sorted and unique', () => {
    const generated = [...ERROR_CODE_UNION];
    expect(generated).toEqual([...generated].sort());
    expect(new Set(generated).size).toBe(generated.length);
  });
});
