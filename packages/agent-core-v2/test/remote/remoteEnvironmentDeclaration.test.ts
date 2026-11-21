import { describe, expect, it } from '@moonshot-ai/testkit/vitest';

import {
  EnvironmentsSectionSchema,
  environmentIdProblem,
} from '#/remote/declaration/remoteEnvironmentDeclaration';

function parse(value: unknown) {
  return EnvironmentsSectionSchema.safeParse(value);
}

describe('EnvironmentsSectionSchema', () => {
  it('rejects reserved environment ids', () => {
    expect(parse({ local: { type: 'ssh', host: 'x' } }).success).toBe(false);
    expect(environmentIdProblem('local')).toContain('reserved');
    expect(environmentIdProblem('default')).toContain('reserved');
  });
});
