import { describe, expect, it } from 'vitest';

import type { CronTask } from '#/app/cron';
import { CRON_ID_REGEX, isValidCronTask } from '#/app/cron';

const validTask: CronTask = {
  id: '0123abcd',
  cron: '*/5 * * * *',
  prompt: 'ping',
  createdAt: 1_700_000_000_000,
  recurring: true,
};

describe('cron persistence guards', () => {
  describe('CRON_ID_REGEX', () => {
    it('accepts 8 character lowercase hex ids', () => {
      expect(CRON_ID_REGEX.test('00000000')).toBe(true);
      expect(CRON_ID_REGEX.test('0123abcd')).toBe(true);
      expect(CRON_ID_REGEX.test('ffffffff')).toBe(true);
    });

    it('rejects non-hex, wrong-length, uppercase, and traversal-looking ids', () => {
      expect(CRON_ID_REGEX.test('0123abc')).toBe(false);
      expect(CRON_ID_REGEX.test('0123abcde')).toBe(false);
      expect(CRON_ID_REGEX.test('0123ABCD')).toBe(false);
      expect(CRON_ID_REGEX.test('zzzzzzzz')).toBe(false);
      expect(CRON_ID_REGEX.test('../etcok')).toBe(false);
    });
  });

  describe('isValidCronTask', () => {
    it('accepts a fully specified recurring task', () => {
      expect(isValidCronTask(validTask)).toBe(true);
    });

    it('accepts a task with omitted recurring', () => {
      const { recurring: _recurring, ...withoutRecurring } = validTask;
      expect(isValidCronTask(withoutRecurring)).toBe(true);
    });

    it('accepts an explicit one-shot task', () => {
      expect(isValidCronTask({ ...validTask, recurring: false })).toBe(true);
    });

    it('rejects non-objects', () => {
      expect(isValidCronTask(null)).toBe(false);
      expect(isValidCronTask(undefined)).toBe(false);
      expect(isValidCronTask('hello')).toBe(false);
      expect(isValidCronTask(42)).toBe(false);
    });

    it('rejects ids outside the cron id shape', () => {
      expect(isValidCronTask({ ...validTask, id: 'NOT-AN-ID' })).toBe(false);
      expect(isValidCronTask({ ...validTask, id: '0123abcde' })).toBe(false);
    });

    it('rejects missing and wrong-typed fields', () => {
      const { cron: _cron, ...withoutCron } = validTask;
      const { prompt: _prompt, ...withoutPrompt } = validTask;

      expect(isValidCronTask(withoutCron)).toBe(false);
      expect(isValidCronTask(withoutPrompt)).toBe(false);
      expect(isValidCronTask({ ...validTask, createdAt: 'recent' })).toBe(false);
      expect(isValidCronTask({ ...validTask, recurring: 'yes' })).toBe(false);
      expect(isValidCronTask({ ...validTask, lastFiredAt: Number.NaN })).toBe(false);
    });
  });
});
