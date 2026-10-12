import { describe, it, expect } from 'vitest';

import { MISSING_APPROVAL_RESULT, readApprovalResult } from '../src/lib/recordGuards';

// Audit a37/F2 — `permission.record_approval_result.result` is only a
// compile-time assertion upstream (`z.custom<…>()`), so an imported or
// hand-edited wire can carry the record without it. Every reader must go
// through this guard instead of dereferencing `r.result`.

describe('readApprovalResult', () => {
  it('reads the four known fields off a well-formed result', () => {
    expect(
      readApprovalResult({
        result: {
          decision: 'approved',
          feedback: 'looks fine',
          scope: 'session',
          selectedLabel: 'allow once',
        },
      }),
    ).toEqual({
      decision: 'approved',
      feedback: 'looks fine',
      scope: 'session',
      selectedLabel: 'allow once',
    });
  });

  it('returns undefined when the record has no usable result', () => {
    expect(readApprovalResult({ result: undefined })).toBeUndefined();
    expect(readApprovalResult({ result: null })).toBeUndefined();
    expect(readApprovalResult({ result: 'broken' })).toBeUndefined();
    expect(readApprovalResult({ result: 42 })).toBeUndefined();
    expect(readApprovalResult({})).toBeUndefined();
    expect(readApprovalResult(null)).toBeUndefined();
    expect(readApprovalResult(undefined)).toBeUndefined();
    expect(readApprovalResult('broken')).toBeUndefined();
  });

  it('drops individual non-string fields instead of passing them through', () => {
    expect(
      readApprovalResult({ result: { decision: { unexpected: true }, feedback: 7 } }),
    ).toEqual({
      decision: undefined,
      feedback: undefined,
      scope: undefined,
      selectedLabel: undefined,
    });
  });

  it('exposes the placeholder used where the result is missing', () => {
    expect(MISSING_APPROVAL_RESULT).toBe('<missing result>');
  });
});
