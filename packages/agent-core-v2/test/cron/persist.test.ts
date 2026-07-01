import { describe, expect, it } from 'vitest';

import { Event } from '#/_base/event';
import type { IDisposable } from '#/_base/di/lifecycle';
import { createCronPersistStore, CRON_ID_REGEX, isValidCronTask } from '#/agent/cron/tools/persist';
import type { CronTask } from '#/agent/cron/tools/types';
import type { IAtomicDocumentStore } from '#/app/storage';

const validTask: CronTask = {
  id: '0123abcd',
  cron: '*/5 * * * *',
  prompt: 'ping',
  createdAt: 1_700_000_000_000,
  recurring: true,
};

class MemoryAtomicDocumentStore implements IAtomicDocumentStore {
  declare readonly _serviceBrand: undefined;

  private readonly data = new Map<string, unknown>();

  async get<T>(scope: string, key: string): Promise<T | undefined> {
    return this.data.get(this.mapKey(scope, key)) as T | undefined;
  }

  async set<T>(scope: string, key: string, value: T): Promise<void> {
    this.data.set(this.mapKey(scope, key), value);
  }

  async delete(scope: string, key: string): Promise<void> {
    this.data.delete(this.mapKey(scope, key));
  }

  async list(scope: string, prefix = ''): Promise<readonly string[]> {
    const marker = `${scope}/`;
    return Array.from(this.data.keys())
      .filter((key) => key.startsWith(marker))
      .map((key) => key.slice(marker.length))
      .filter((key) => key.startsWith(prefix))
      .toSorted();
  }

  watch(_scope: string, _key: string): Event<void> {
    return Event.None as Event<void>;
  }

  acquire(_scope: string, _key: string): IDisposable {
    return { dispose() {} };
  }

  private mapKey(scope: string, key: string): string {
    return `${scope}/${key}`;
  }
}

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

  describe('createCronPersistStore', () => {
    it('roundtrips valid tasks through the cron document scope', async () => {
      const documents = new MemoryAtomicDocumentStore();
      const store = createCronPersistStore(documents);

      await store.write(validTask.id, validTask);

      expect(await documents.get('cron', `${validTask.id}.json`)).toEqual(validTask);
      expect(await store.list()).toEqual([validTask]);
    });

    it('skips invalid keys and invalid task records while listing', async () => {
      const documents = new MemoryAtomicDocumentStore();
      const store = createCronPersistStore(documents);

      await documents.set('cron', '0123abcd.json', validTask);
      await documents.set('cron', 'ffffffff.json', { ...validTask, id: 'BAD' });
      await documents.set('cron', 'readme.txt', validTask);
      await documents.set('other', 'deadbeef.json', { ...validTask, id: 'deadbeef' });

      expect(await store.list()).toEqual([validTask]);
    });

    it('validates ids before writing or deleting document keys', async () => {
      const store = createCronPersistStore(new MemoryAtomicDocumentStore());

      await expect(store.write('../etcok', validTask)).rejects.toThrow(/Invalid cron job id/);
      await expect(store.remove('0123ABCD')).rejects.toThrow(/Invalid cron job id/);
    });
  });
});
