import { describe, expect, it } from 'bun:test';

import { Error2, ErrorCodes, ProfileErrors } from '@moonshot-ai/agent-core-v2';

import { isMissingConfiguredModel } from '../../src/services/legacyStatus/legacyStatus';

describe('legacy status model recovery', () => {
  it('recognizes the config error a removed model alias raises', () => {
    const error = new Error2(
      ErrorCodes.CONFIG_INVALID,
      'Model "removed-model" is not configured in config.toml.',
      { details: { model: 'removed-model' } },
    );

    expect(isMissingConfiguredModel(error, 'removed-model')).toBe(true);
    expect(isMissingConfiguredModel(error, 'other-model')).toBe(false);
  });

  it('accepts the profile error code and rejects unrelated failures', () => {
    const profileError = new Error2(
      ProfileErrors.codes.MODEL_CONFIG_INVALID,
      'Model "removed-model" is not configured in config.toml.',
      { details: { model: 'removed-model' } },
    );
    const other = new Error2(ErrorCodes.CONFIG_INVALID, 'other config failure');

    expect(isMissingConfiguredModel(profileError, 'removed-model')).toBe(true);
    expect(isMissingConfiguredModel(other, 'removed-model')).toBe(false);
    expect(isMissingConfiguredModel(new Error('plain'), 'removed-model')).toBe(false);
  });
});
