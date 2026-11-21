import { expect, test } from 'bun:test';

import { fixtureTest, runFixtures } from '#/bun/index';

const tracked: string[] = [];
const withResource = fixtureTest<{ first: string; second: string }>({
  first: async ({ task }, use) => {
    tracked.push(`first:${task.name}`);
    try {
      await use('one');
    } finally {
      tracked.push('close:first');
    }
  },
  second: async ({ first }, use) => {
    tracked.push(`second:${first}`);
    try {
      await use('two');
    } finally {
      tracked.push('close:second');
    }
  },
});

withResource('provides dependent fixtures through Bun tests', ({ first, second }) => {
  expect({ first, second }).toEqual({ first: 'one', second: 'two' });
  expect(tracked).toEqual([
    'first:provides dependent fixtures through Bun tests',
    'second:one',
  ]);
});

test('disposes fixtures in reverse dependency order', () => {
  expect(tracked.slice(-2)).toEqual(['close:second', 'close:first']);
});

test('reports failures once and disposes every acquired fixture', async () => {
  const lifecycle: string[] = [];
  let caught: unknown;
  try {
    await runFixtures<{ value: number }>('failed body', {
      value: async ({ onTestFailed }, use) => {
        onTestFailed(() => lifecycle.push('reported'));
        try {
          await use(1);
        } finally {
          lifecycle.push('closed');
        }
      },
    }, () => { throw new Error('body failed'); });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toBe('body failed');
  expect(lifecycle).toEqual(['closed', 'reported']);
});

test('rejects a fixture that omits use instead of silently skipping the body', async () => {
  let caught: unknown;
  let called = false;
  try {
    await runFixtures<{ value: number }>('missing use', { value: async () => {} }, () => { called = true; });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain('never called use');
  expect(called).toBe(false);
});
