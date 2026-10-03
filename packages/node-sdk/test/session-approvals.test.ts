import { describe, expect, it } from 'vitest';

import {
  isApprovedForSession,
  rememberSessionApproval,
} from '../src/native/session-approvals';

/**
 * These assert the user-visible requirement — that an approval for the session
 * stops the user being asked again — rather than that a field travelled through
 * the wire. A test of the plumbing passes even when the feature does nothing,
 * which is the failure mode this file exists to prevent.
 */
describe('session-scoped approvals', () => {
  const rule = 'Bash(npm test)';

  it('stops asking for a rule the user already approved for the session', () => {
    // The whole point: turn 1 approves, turn 5 must not ask again.
    expect(isApprovedForSession(rule, [rule])).toBe(true);
    expect(isApprovedForSession(rule, [])).toBe(false);
  });

  it('still asks for a different rule', () => {
    // Approving `Bash(npm test)` says nothing about `Bash(rm -rf /)`. If this
    // ever returns true, one approval has become a tool-wide grant.
    expect(isApprovedForSession('Bash(rm -rf /)', [rule])).toBe(false);
    expect(isApprovedForSession('Bash(npm test --watch)', [rule])).toBe(false);
  });

  it('never auto-approves a request that names no rule', () => {
    // A policy ask (or a host-owned tool) carries no rule. Matching on the tool
    // name instead would be the over-grant, so the answer must be no.
    const approved = [rule, 'Bash'];
    expect(isApprovedForSession(undefined, approved)).toBe(false);
    expect(isApprovedForSession('', approved)).toBe(false);
  });

  it('remembers only an approval that says scope: session', () => {
    const once = rememberSessionApproval(rule, { decision: 'approved' }, []);
    expect(once).toEqual([]);

    const forSession = rememberSessionApproval(
      rule,
      { decision: 'approved', scope: 'session' },
      [],
    );
    expect(forSession).toEqual([rule]);
  });

  it('never remembers a rejection, whatever the scope says', () => {
    // A remembered refusal would silently deny work the user was never asked
    // about. This is the direction that matters: a test that only checked
    // approvals would not notice the bug.
    expect(
      rememberSessionApproval(
        rule,
        { decision: 'rejected', scope: 'session' },
        [],
      ),
    ).toEqual([]);
    expect(
      rememberSessionApproval(
        rule,
        { decision: 'cancelled', scope: 'session' },
        [],
      ),
    ).toEqual([]);
  });

  it('remembers nothing when the request carried no rule', () => {
    expect(
      rememberSessionApproval(undefined, { decision: 'approved', scope: 'session' }, []),
    ).toEqual([]);
    expect(
      rememberSessionApproval('', { decision: 'approved', scope: 'session' }, []),
    ).toEqual([]);
  });

  it('is idempotent: approving the same rule twice keeps one entry', () => {
    const once = rememberSessionApproval(rule, { decision: 'approved', scope: 'session' }, []);
    const twice = rememberSessionApproval(
      rule,
      { decision: 'approved', scope: 'session' },
      once,
    );
    expect(twice).toEqual([rule]);
  });

  it('does not mutate the list it was given', () => {
    // The caller holds this array on session meta; mutating it in place would
    // change what a concurrent evaluation sees.
    const existing = [rule];
    rememberSessionApproval('Bash(lint)', { decision: 'approved', scope: 'session' }, existing);
    expect(existing).toEqual([rule]);
  });
});