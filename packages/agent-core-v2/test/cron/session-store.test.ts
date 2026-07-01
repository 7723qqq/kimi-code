import { describe, expect, it } from 'vitest';

import {
  SessionCronStore,
  type SessionCronTaskInit,
} from '#/agent/cron/tools/session-store';
import type { CronTask } from '#/agent/cron/tools/types';

const ID_REGEX = /^[0-9a-f]{8}$/;

function makeInit(
  suffix: string,
  overrides: Partial<SessionCronTaskInit> = {},
): SessionCronTaskInit {
  return {
    cron: '*/5 * * * *',
    prompt: `prompt-${suffix}`,
    recurring: true,
    ...overrides,
  };
}

describe('SessionCronStore', () => {
  describe('add', () => {
    it('returns a generated 8-hex id', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1000);
      expect(task.id).toMatch(ID_REGEX);
    });

    it('preserves cron, prompt, and recurring from the init', () => {
      const store = new SessionCronStore();
      const task = store.add(
        { cron: '0 9 * * 1-5', prompt: 'sync prs', recurring: false },
        1000,
      );

      expect(task.cron).toBe('0 9 * * 1-5');
      expect(task.prompt).toBe('sync prs');
      expect(task.recurring).toBe(false);
    });

    it('sets createdAt from the supplied clock value', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1_700_000_000_000);
      expect(task.createdAt).toBe(1_700_000_000_000);
    });

    it('does not consult Date.now()', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 0);
      expect(task.createdAt).toBe(0);
    });

    it('produces distinct ids for rapid sequential adds', () => {
      const store = new SessionCronStore();
      const ids = new Set<string>();

      for (let i = 0; i < 32; i++) {
        ids.add(store.add(makeInit(`x${i}`), 1000 + i).id);
      }

      expect(ids.size).toBe(32);
    });
  });

  describe('adopt', () => {
    it('preserves a persisted task id and createdAt', () => {
      const store = new SessionCronStore();
      const task: CronTask = {
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'morning',
        createdAt: 1234,
        recurring: true,
      };

      store.adopt(task);

      expect(store.get('deadbeef')).toEqual(task);
    });

    it('replaces an existing task with the same id', () => {
      const store = new SessionCronStore();
      store.adopt({
        id: 'deadbeef',
        cron: '0 9 * * *',
        prompt: 'old',
        createdAt: 1,
      });
      store.adopt({
        id: 'deadbeef',
        cron: '0 10 * * *',
        prompt: 'new',
        createdAt: 2,
      });

      expect(store.list()).toEqual([
        {
          id: 'deadbeef',
          cron: '0 10 * * *',
          prompt: 'new',
          createdAt: 2,
        },
      ]);
    });
  });

  describe('markFired', () => {
    it('returns and stores a copy with lastFiredAt', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1000);

      const updated = store.markFired(task.id, 2000);

      expect(updated).toEqual({ ...task, lastFiredAt: 2000 });
      expect(store.get(task.id)).toEqual({ ...task, lastFiredAt: 2000 });
    });

    it('returns undefined for an unknown id', () => {
      const store = new SessionCronStore();
      expect(store.markFired('deadbeef', 2000)).toBeUndefined();
    });
  });

  describe('get', () => {
    it('returns a previously added task', () => {
      const store = new SessionCronStore();
      const task = store.add(makeInit('a'), 1000);
      expect(store.get(task.id)).toEqual(task);
    });

    it('returns undefined for an unknown id', () => {
      const store = new SessionCronStore();
      expect(store.get('deadbeef')).toBeUndefined();
    });
  });

  describe('list', () => {
    it('returns tasks in insertion order', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      const t2 = store.add(makeInit('2'), 1001);
      const t3 = store.add(makeInit('3'), 1002);

      expect(store.list().map((t) => t.id)).toEqual([t1.id, t2.id, t3.id]);
    });

    it('returns a fresh array each time', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);

      const a = store.list();
      const b = store.list();

      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });

    it('does not let callers mutate the backing store through a list snapshot', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);

      const snapshot = store.list() as unknown as CronTask[];
      snapshot.length = 0;

      expect(store.list()).toHaveLength(1);
    });

    it('returns an empty array for a fresh store', () => {
      const store = new SessionCronStore();
      expect(store.list()).toEqual([]);
    });
  });

  describe('remove', () => {
    it('returns only ids that were present', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      const t2 = store.add(makeInit('2'), 1001);

      expect(store.remove([t1.id, 'missing0', t2.id])).toEqual([t1.id, t2.id]);
    });

    it('removes tasks from get and list', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);

      store.remove([t1.id]);

      expect(store.get(t1.id)).toBeUndefined();
      expect(store.list()).toEqual([]);
    });

    it('returns an empty array when nothing matches', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);
      expect(store.remove(['ffffffff', 'eeeeeeee'])).toEqual([]);
    });

    it('preserves insertion order of remaining tasks', () => {
      const store = new SessionCronStore();
      const t1 = store.add(makeInit('1'), 1000);
      const t2 = store.add(makeInit('2'), 1001);
      const t3 = store.add(makeInit('3'), 1002);

      store.remove([t2.id]);

      expect(store.list().map((t) => t.id)).toEqual([t1.id, t3.id]);
    });
  });

  describe('clear', () => {
    it('empties the store', () => {
      const store = new SessionCronStore();
      store.add(makeInit('a'), 1000);
      store.add(makeInit('b'), 1001);

      store.clear();

      expect(store.list()).toEqual([]);
    });

    it('is a no-op on an empty store', () => {
      const store = new SessionCronStore();
      expect(() => store.clear()).not.toThrow();
      expect(store.list()).toEqual([]);
    });
  });

  it('generates unique ids at cron-session scale', () => {
    const store = new SessionCronStore();
    const ids = new Set<string>();

    for (let i = 0; i < 256; i++) {
      const task = store.add(makeInit(`x${i}`), 1000 + i);
      expect(task.id).toMatch(ID_REGEX);
      ids.add(task.id);
    }

    expect(ids.size).toBe(256);
    expect(store.list()).toHaveLength(256);
  });
});
