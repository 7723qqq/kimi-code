// apps/kimi-web/src/lib/__tests__/slashCommands.test.ts
import { describe, expect, it } from 'vitest';
import { SLASH_COMMANDS, filterCommands, parseSlash } from '../slashCommands';

describe('parseSlash', () => {
  it('parses a bare slash command with no arg', () => {
    expect(parseSlash('/help')).toEqual({ cmd: '/help', arg: '' });
  });

  it('parses a slash command with an arg', () => {
    expect(parseSlash('/new my-session')).toEqual({ cmd: '/new', arg: 'my-session' });
  });

  it('parses /permission with trailing space + arg', () => {
    expect(parseSlash('/permission auto')).toEqual({ cmd: '/permission', arg: 'auto' });
  });

  it('returns null when input does not start with /', () => {
    expect(parseSlash('hello')).toBeNull();
    expect(parseSlash('hello /help')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseSlash('')).toBeNull();
  });

  it('returns null when slash is preceded by whitespace', () => {
    expect(parseSlash('  /help')).toBeNull();
  });

  it('handles just a slash', () => {
    expect(parseSlash('/')).toEqual({ cmd: '/', arg: '' });
  });

  it('handles /compact with no trailing space', () => {
    expect(parseSlash('/compact')).toEqual({ cmd: '/compact', arg: '' });
  });
});

describe('filterCommands', () => {
  it('returns all commands for empty query', () => {
    expect(filterCommands('')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('returns all commands for "/" query', () => {
    expect(filterCommands('/')).toHaveLength(SLASH_COMMANDS.length);
  });

  it('prefix match: /hel matches /help', () => {
    const result = filterCommands('/hel');
    expect(result.some((c) => c.name === '/help')).toBe(true);
  });

  it('substring match: comp matches /compact', () => {
    const result = filterCommands('comp');
    expect(result.some((c) => c.name === '/compact')).toBe(true);
  });

  it('case-insensitive: /HELP matches /help', () => {
    const result = filterCommands('/HELP');
    expect(result.some((c) => c.name === '/help')).toBe(true);
  });

  it('no match returns empty array', () => {
    expect(filterCommands('/zzz_no_match')).toHaveLength(0);
  });

  it('partial /per matches /permission', () => {
    const result = filterCommands('/per');
    expect(result.some((c) => c.name === '/permission')).toBe(true);
  });

  it('all known commands are in SLASH_COMMANDS', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('/help');
    expect(names).toContain('/new');
    expect(names).toContain('/clear');
    expect(names).toContain('/model');
    expect(names).toContain('/permission');
    expect(names).toContain('/compact');
    expect(names).toContain('/status');
    expect(names).toContain('/undo');
    expect(names).toContain('/tasks');
  });
});
