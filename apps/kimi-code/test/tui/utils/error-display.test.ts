import { describe, expect, it } from 'vitest';

import {
  formatLocalizedError,
  localizedErrorAction,
  localizedErrorTitle,
} from '#/tui/utils/error-display';

describe('localized error display', () => {
  it('maps a dotted error code onto its camelCase locale key', () => {
    expect(localizedErrorTitle('goal.not_found')).toBe('No goal found');
    expect(localizedErrorAction('goal.not_found')).toBe(
      'Start a goal with "/goal <objective>" first.',
    );
  });

  it('returns undefined for a code with no localized entry', () => {
    expect(localizedErrorTitle('not.a.real.code')).toBeUndefined();
    expect(localizedErrorAction('not.a.real.code')).toBeUndefined();
  });

  it('renders the localized title, action, and the raw message as detail', () => {
    expect(formatLocalizedError({ code: 'goal.not_found', message: 'Goal not found: no goal' })).toBe(
      '[goal.not_found] No goal found\n' +
        'Start a goal with "/goal <objective>" first.\n' +
        'Goal not found: no goal',
    );
  });

  it('omits the detail line when the message repeats the title', () => {
    expect(formatLocalizedError({ code: 'internal', message: 'Internal error' })).toBe(
      '[internal] Internal error',
    );
  });

  it('falls back to the raw payload for an uncovered code', () => {
    expect(formatLocalizedError({ code: 'not.a.real.code', message: 'boom' })).toBe(
      '[not.a.real.code] boom',
    );
  });

  it('falls back to the raw payload when no code is present', () => {
    expect(formatLocalizedError({ message: 'boom' })).toBe('boom');
    expect(formatLocalizedError(undefined)).toBe('');
  });
});
