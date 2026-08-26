/**
 * TUI2 device-code login card holder tests.
 *
 * `showLoginAuthorizationPrompt` records the pending OAuth login as an
 * active card keyed by the appended transcript entry id; MainShell swaps
 * that entry's plain status row for the rounded card. These tests pin the
 * holder contract the host and the shell share.
 */

import { afterEach, describe, expect, it } from 'vitest'

import {
  activeDeviceCodeCard,
  clearDeviceCodeCard,
  setDeviceCodeCard,
} from '@/tui2/components/chrome/device-code-box'

afterEach(() => {
  clearDeviceCodeCard();
});

describe('device code card holder', () => {
  it('exposes the card recorded for a transcript entry', () => {
    setDeviceCodeCard({
      entryId: 'entry-1',
      title: 'Sign in to Kimi Code',
      url: 'https://example.test/activate',
      code: 'ABCD-1234',
      hint: 'Press Ctrl-C to cancel',
    });
    const card = activeDeviceCodeCard();
    expect(card?.entryId).toBe('entry-1');
    expect(card?.url).toBe('https://example.test/activate');
    expect(card?.code).toBe('ABCD-1234');
  });

  it('replaces a previous card and clears to undefined', () => {
    setDeviceCodeCard({ entryId: 'a', title: 't', url: 'u', code: 'c' });
    setDeviceCodeCard({ entryId: 'b', title: 't2', url: 'u2', code: 'c2' });
    expect(activeDeviceCodeCard()?.entryId).toBe('b');
    clearDeviceCodeCard();
    expect(activeDeviceCodeCard()).toBeUndefined();
  });

  it('starts empty on a fresh module graph', () => {
    expect(activeDeviceCodeCard()).toBeUndefined();
  });
});
