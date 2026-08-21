import { describe, expect, it } from 'vitest';

import { forkIncompatibility, type ForkCompatInputLike } from '#/session/subagent/forkCompat';

function input(partial: Partial<ForkCompatInputLike> = {}): ForkCompatInputLike {
  return { ...partial };
}

describe('forkIncompatibility', () => {
  it('returns undefined when fork is not requested', () => {
    expect(forkIncompatibility(input())).toBeUndefined();
    expect(forkIncompatibility(input({ fork: false }))).toBeUndefined();
  });

  it('returns undefined for a clean fork request', () => {
    expect(forkIncompatibility(input({ fork: true }))).toBeUndefined();
  });

  it('rejects fork combined with resume (resume targets an existing agent)', () => {
    const err = forkIncompatibility(input({ fork: true, resume: 'agent-1' }));
    expect(err).toBeDefined();
    expect(err).toContain('Cannot use fork with resume');
  });

  it('treats a whitespace-only resume as absent', () => {
    expect(forkIncompatibility(input({ fork: true, resume: '   ' }))).toBeUndefined();
  });

  it('rejects fork combined with subagent_type (fork inherits the caller profile)', () => {
    const err = forkIncompatibility(input({ fork: true, subagent_type: 'explore' }));
    expect(err).toBeDefined();
    expect(err).toContain('Cannot use fork with subagent_type');
  });

  it('rejects fork combined with model (fork inherits the caller model)', () => {
    const err = forkIncompatibility(input({ fork: true, model: 'provider/fast' }));
    expect(err).toBeDefined();
    expect(err).toContain('Cannot use fork with model');
  });

  it('reports the first violation only (resume beats subagent_type beats model)', () => {
    expect(forkIncompatibility(input({ fork: true, resume: 'r', subagent_type: 'x' }))).toContain(
      'resume',
    );
    expect(
      forkIncompatibility(input({ fork: true, subagent_type: 'x', model: 'm' })),
    ).toContain('subagent_type');
  });
});
