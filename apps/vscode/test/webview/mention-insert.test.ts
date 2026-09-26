import { describe, expect, it } from 'vitest';

import { applySelectionSync, computeMentionInsert } from '@/components/inputarea/utils';

describe('computeMentionInsert', () => {
  it('replaces the active token with the mention and moves the cursor past it', () => {
    const result = computeMentionInsert({
      text: 'check @ap',
      cursorPos: 9,
      filePath: 'src/app.ts',
      activeToken: { start: 6 },
      isAppend: false,
    });
    expect(result.newText).toBe('check @src/app.ts ');
    expect(result.newCursorPos).toBe(result.newText.length);
  });

  it('appends the mention when there is no active token', () => {
    const result = computeMentionInsert({
      text: 'hi ',
      cursorPos: 3,
      filePath: 'a.ts',
      activeToken: null,
      isAppend: true,
    });
    expect(result.newText).toBe('hi @a.ts ');
    expect(result.newCursorPos).toBe(result.newText.length);
  });

  it('quotes a path containing spaces so whitespace cannot split the mention', () => {
    const result = computeMentionInsert({
      text: '@my',
      cursorPos: 3,
      filePath: 'My Folder/app.ts',
      activeToken: { start: 0 },
      isAppend: false,
    });
    expect(result.newText).toBe('@"My Folder/app.ts" ');
    expect(result.newCursorPos).toBe(result.newText.length);
  });

  it('quotes a path containing spaces in append mode', () => {
    const result = computeMentionInsert({
      text: '',
      cursorPos: 0,
      filePath: 'My Folder',
      activeToken: null,
      isAppend: true,
    });
    expect(result.newText).toBe('@"My Folder" ');
  });
});

describe('applySelectionSync', () => {
  it('appends on the first sync, when there is nothing to replace', () => {
    const result = applySelectionSync('look at ', null, '@src/app.ts:10');
    expect(result.newText).toBe('look at @src/app.ts:10 ');
    expect(result.lastSynced).toBe('@src/app.ts:10');
  });

  it('replaces the previous mention as the selection grows, never appending', () => {
    const first = applySelectionSync('', null, '@src/app.ts:10');
    const second = applySelectionSync(first.newText, first.lastSynced, '@src/app.ts:10-20');
    const third = applySelectionSync(second.newText, second.lastSynced, '@src/app.ts:10-30');

    expect(third.newText).toBe('@src/app.ts:10-30 ');
    // One mention survives a three-step drag.
    expect(third.newText.match(/@src/g)).toHaveLength(1);
  });

  it('keeps surrounding draft text intact', () => {
    const first = applySelectionSync('why? ', null, '@a.ts:1');
    const second = applySelectionSync(first.newText, first.lastSynced, '@a.ts:2');
    expect(second.newText).toBe('why? @a.ts:2 ');
  });

  it('drops a stale echo once the user has edited the mention away', () => {
    const first = applySelectionSync('', null, '@a.ts:1');
    // The user deleted the mention and typed their own text.
    const edited = 'my own question';
    const result = applySelectionSync(edited, first.lastSynced, '@a.ts:2');

    expect(result.newText).toBe('my own question');
    // The anchor is kept so the next genuine sync still has something to replace.
    expect(result.lastSynced).toBe('@a.ts:1');
  });
});
