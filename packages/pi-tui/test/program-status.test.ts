import { describe, expect, it } from 'bun:test';

import { formatProgramStatus, isProgramStatusReply } from '../src/program-status.ts';

function decodeMessage(sequence: string): string | undefined {
  const message = /:msg=([A-Za-z0-9+/=]*)/.exec(sequence)?.[1];
  return message === undefined ? undefined : Buffer.from(message, 'base64').toString('utf8');
}

function decodeTitle(sequence: string): string | undefined {
  const title = /:title=([A-Za-z0-9+/=]*)/.exec(sequence)?.[1];
  return title === undefined ? undefined : Buffer.from(title, 'base64').toString('utf8');
}

describe('formatProgramStatus', () => {
  it('encodes state, app, kind, and a base64 message', () => {
    expect(
      formatProgramStatus({
        state: 'blocked',
        app: 'pi',
        kind: 'permission',
        message: 'Allow bash?',
      }),
    ).toBe(
      `\x1b]7501;state=blocked:app=pi:kind=permission:msg=${Buffer.from('Allow bash?').toString('base64')}\x1b\\`,
    );
    expect(formatProgramStatus({ state: 'clear' })).toBe('\x1b]7501;state=clear\x1b\\');
  });

  it('encodes child ids and titles, including child clears', () => {
    expect(
      formatProgramStatus({
        state: 'blocked',
        app: 'pi',
        kind: 'question',
        id: 'agent/one',
        title: 'Review changes',
      }),
    ).toBe(
      `\x1b]7501;state=blocked:app=pi:kind=question:id=agent/one:title=${Buffer.from('Review changes').toString('base64')}\x1b\\`,
    );
    expect(formatProgramStatus({ state: 'clear', id: 'agent/one' })).toBe(
      '\x1b]7501;state=clear:id=agent/one\x1b\\',
    );
  });

  it('rejects invalid ids instead of falling back to the root record', () => {
    const invalidIds = [
      '',
      'bad id',
      'bad:id',
      '/agent',
      'agent/',
      'agent//one',
      'a'.repeat(33),
      Array.from({ length: 9 }, () => 'a').join('/'),
      `${'a'.repeat(32)}/${'a'.repeat(32)}/${'a'.repeat(32)}/${'a'.repeat(30)}`,
    ];
    for (const id of invalidIds) {
      expect(() => formatProgramStatus({ state: 'working', id })).toThrow(
        /Invalid program status id/,
      );
    }
  });

  it('sanitizes titles and cuts them at a UTF-8 boundary within 192 bytes', () => {
    expect(
      decodeTitle(formatProgramStatus({ state: 'working', id: 'agent', title: 'first\nsecond\t' })),
    ).toBe('first second');
    const title = decodeTitle(
      formatProgramStatus({ state: 'working', id: 'agent', title: 'é'.repeat(200) }),
    )!;
    expect(title).toBe('é'.repeat(96));
    expect(Buffer.byteLength(title) <= 192).toBe(true);
  });

  it('omits kind outside blocked, invalid app names, and empty messages', () => {
    expect(
      formatProgramStatus({ state: 'working', app: 'my app', kind: 'auth', message: ' \n ' }),
    ).toBe('\x1b]7501;state=working\x1b\\');
    expect(formatProgramStatus({ state: 'idle', app: 'a'.repeat(32) })).toMatch(/:app=a{32}\x1b/);
    expect(formatProgramStatus({ state: 'idle', app: 'a'.repeat(33) })).not.toMatch(/app=/);
  });

  it('replaces control characters, which make terminals discard the report', () => {
    const sequence = formatProgramStatus({
      state: 'error',
      message: 'first\nsecond\x1b[31m\u009bthird\t',
    });
    expect(decodeMessage(sequence)).toBe('first second [31m third');
  });

  it('cuts long messages at a UTF-8 boundary within the spec limits', () => {
    const sequence = formatProgramStatus({
      state: 'working',
      app: 'pi',
      message: 'é'.repeat(2000),
    });
    const message = decodeMessage(sequence)!;
    expect(message).toBe('é'.repeat(1024));
    expect(Buffer.byteLength(message) <= 2048).toBe(true);
    expect(sequence.length <= 4096).toBe(true);
  });
});

describe('isProgramStatusReply', () => {
  it('accepts the query echo with either terminator and future pairs', () => {
    expect(isProgramStatusReply('\x1b]7501;?\x1b\\')).toBe(true);
    expect(isProgramStatusReply('\x1b]7501;?\x07')).toBe(true);
    expect(isProgramStatusReply('\x1b]7501;?version=2\x1b\\')).toBe(true);
    expect(isProgramStatusReply('\x1b]7501;state=idle\x1b\\')).toBe(false);
    expect(isProgramStatusReply('\x1b]11;rgb:0000/0000/0000\x07')).toBe(false);
  });
});
