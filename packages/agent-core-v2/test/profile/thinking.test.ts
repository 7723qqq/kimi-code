import { describe, expect, it } from 'vitest';

import {
  resolveThinkingEffort,
  resolveThinkingLevel,
} from '#/agent/profile/thinking';

describe('profile/thinking', () => {
  describe('resolveThinkingEffort', () => {
    it('returns config effort when no request', () => {
      expect(resolveThinkingEffort(undefined, { effort: 'low' })).toBe('low');
    });

    it('defaults to off when no model supports thinking', () => {
      expect(resolveThinkingEffort(undefined, undefined)).toBe('off');
    });

    it('uses the model default effort when configured', () => {
      expect(
        resolveThinkingEffort(undefined, undefined, {
          capabilities: ['thinking'],
          supportEfforts: ['low', 'medium', 'max'],
          defaultEffort: 'max',
        }),
      ).toBe('max');
    });

    it('uses the middle supported effort when no default effort is configured', () => {
      expect(
        resolveThinkingEffort(undefined, undefined, {
          capabilities: ['thinking'],
          supportEfforts: ['low', 'medium', 'max'],
        }),
      ).toBe('medium');
    });

    it('uses boolean on for thinking models without named efforts', () => {
      expect(
        resolveThinkingEffort(undefined, undefined, {
          capabilities: ['thinking'],
        }),
      ).toBe('on');
    });

    it('returns off when config mode is off and no request is provided', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'off' })).toBe('off');
    });

    it('returns model default when config mode is on without explicit effort', () => {
      expect(
        resolveThinkingEffort(undefined, { mode: 'on' }, {
          capabilities: ['thinking'],
          supportEfforts: ['low', 'high'],
        }),
      ).toBe('high');
    });

    it('returns explicit effort when both mode=on and effort are set', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'on', effort: 'medium' })).toBe('medium');
    });

    it('returns off when mode is off even if effort is set', () => {
      expect(resolveThinkingEffort(undefined, { mode: 'off', effort: 'high' })).toBe('off');
    });

    it('honors explicit "off"', () => {
      expect(resolveThinkingEffort('off', { effort: 'high' })).toBe('off');
    });

    it('maps "on" to the configured effort', () => {
      expect(resolveThinkingEffort('on', { effort: 'medium' })).toBe('medium');
    });

    it('maps "on" to the model default when config has no effort', () => {
      expect(
        resolveThinkingEffort('on', undefined, {
          capabilities: ['thinking'],
          supportEfforts: ['low', 'medium', 'max'],
        }),
      ).toBe('medium');
    });

    it('parses a named effort', () => {
      expect(resolveThinkingEffort('xhigh', undefined)).toBe('xhigh');
    });

    it('carries custom requested efforts through', () => {
      expect(resolveThinkingEffort('bogus', { effort: 'low' })).toBe('bogus');
    });

    it('normalizes requested effort case and whitespace', () => {
      expect(resolveThinkingEffort('  Medium ', undefined)).toBe('medium');
      expect(resolveThinkingEffort('OFF', { mode: 'on' })).toBe('off');
    });

    it('clamps off to model default for always-thinking models', () => {
      expect(
        resolveThinkingEffort('off', undefined, {
          capabilities: ['always_thinking'],
          alwaysThinking: true,
          supportEfforts: ['low', 'medium', 'max'],
        }),
      ).toBe('medium');
    });
  });

  describe('resolveThinkingLevel', () => {
    it('uses requested level when provided', () => {
      expect(resolveThinkingLevel('high', {})).toBe('high');
    });

    it('returns "off" when defaultThinking is false and no request', () => {
      expect(resolveThinkingLevel(undefined, { defaultThinking: false })).toBe('off');
    });

    it('honors thinking.mode = off', () => {
      expect(resolveThinkingLevel(undefined, { thinking: { mode: 'off' } })).toBe('off');
    });
  });
});
