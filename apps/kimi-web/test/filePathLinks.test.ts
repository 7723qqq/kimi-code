import { describe, expect, it } from 'vitest';
import { findFilePathLinks, parseFilePathLinkCandidate } from '../src/lib/filePathLinks';

describe('file path links', () => {
  it('parses relative paths with line numbers', () => {
    expect(parseFilePathLinkCandidate('apps/kimi-web/src/App.vue:23')).toEqual({
      path: 'apps/kimi-web/src/App.vue',
      line: 23,
    });
    expect(parseFilePathLinkCandidate('src/foo.ts#L9')).toEqual({
      path: 'src/foo.ts',
      line: 9,
    });
  });

  it('parses common root filenames', () => {
    expect(parseFilePathLinkCandidate('package.json')).toEqual({ path: 'package.json' });
    expect(parseFilePathLinkCandidate('AGENTS.md')).toEqual({ path: 'AGENTS.md' });
  });

  it('ignores URLs and non-path words', () => {
    expect(parseFilePathLinkCandidate('https://example.com/a.ts')).toBeNull();
    expect(parseFilePathLinkCandidate('hello')).toBeNull();
  });

  it('finds multiple links in message text', () => {
    expect(findFilePathLinks('See apps/kimi-web/src/App.vue:11 and package.json.')).toEqual([
      {
        path: 'apps/kimi-web/src/App.vue',
        line: 11,
        start: 4,
        end: 32,
        text: 'apps/kimi-web/src/App.vue:11',
      },
      {
        path: 'package.json',
        line: undefined,
        start: 37,
        end: 49,
        text: 'package.json',
      },
    ]);
  });
});
