import { describe, expect, test } from 'bun:test';

import { CliArgError, DEFAULT_REPS, parseArgs } from '../src/cli-args';
import { AUTHORIZED_ACTUAL_GLOBAL_PATH, PROMPT_PROFILES } from '../src/rendered-prompt';

describe('parseArgs accepts known flags', () => {
  test('reads the command and flags', () => {
    const args = parseArgs(['bench', '--model', 'x', '--dry-run']);
    expect(args.command).toBe('bench');
    expect(args.model).toBe('x');
    expect(args.dryRun).toBe(true);
    expect(args.reps).toBe(DEFAULT_REPS);
    expect(args.variants).toEqual([]);
  });

  test('defaults are inert', () => {
    const args = parseArgs([]);
    expect(args.command).toBeUndefined();
    expect(args.model).toBeUndefined();
    expect(args.dryRun).toBe(false);
  });

  test('collects repeated --variant in order', () => {
    expect(parseArgs(['ab', '--variant', 'base', '--variant', 'prune:Coding']).variants).toEqual([
      'base',
      'prune:Coding',
    ]);
  });

  test('falls back to the default for a non-numeric or non-positive --reps', () => {
    expect(parseArgs(['probe', '--reps', 'abc']).reps).toBe(DEFAULT_REPS);
    expect(parseArgs(['probe', '--reps', '0']).reps).toBe(DEFAULT_REPS);
    expect(parseArgs(['probe', '--reps', '5']).reps).toBe(5);
  });
});

describe('parseArgs rejects what it does not understand', () => {
  // Regression guard: --bogus-flag used to be dropped silently, so a typo like
  // --dryrun became a real API run.
  test('an unknown flag throws and names itself', () => {
    expect(() => parseArgs(['bench', '--bogus-flag'])).toThrow(CliArgError);
    expect(() => parseArgs(['bench', '--bogus-flag'])).toThrow(/--bogus-flag/);
  });

  test('the message lists the supported flags', () => {
    expect(() => parseArgs(['bench', '--bogus-flag'])).toThrow(/--dry-run/);
  });

  test('a misspelled boolean flag is not treated as absent', () => {
    expect(() => parseArgs(['bench', '--dryrun'])).toThrow(/--dryrun/);
  });

  test('a stray positional argument throws', () => {
    expect(() => parseArgs(['bench', 'extra'])).toThrow(/extra/);
  });

  test('a value flag without a value throws', () => {
    expect(() => parseArgs(['bench', '--model'])).toThrow(/--model requires a value/);
  });

  test('a value flag followed by another flag throws', () => {
    expect(() => parseArgs(['bench', '--model', '--dry-run'])).toThrow(/--model requires a value/);
  });
});

describe('parseArgs selects the rendered profile', () => {
  test('defaults to the full profile', () => {
    expect(parseArgs(['bench']).profile).toBe('full');
  });

  test('accepts every production profile', () => {
    for (const profile of PROMPT_PROFILES) {
      expect(parseArgs(['bench', '--profile', profile]).profile).toBe(profile);
    }
  });

  test('an unknown profile throws and lists the legal values', () => {
    expect(() => parseArgs(['bench', '--profile', 'deepseek'])).toThrow(CliArgError);
    expect(() => parseArgs(['bench', '--profile', 'deepseek'])).toThrow(
      /full, minimal, deepseek-adapted/,
    );
    expect(() => parseArgs(['bench', '--profile', 'deepseek'])).toThrow(/--profile "deepseek"/);
  });

  test('--profile without a value throws rather than falling back to full', () => {
    expect(() => parseArgs(['bench', '--profile'])).toThrow(/--profile requires a value/);
  });
});

describe('parseArgs reads the actual-global opt-in', () => {
  test('parses the authorized path as a value flag', () => {
    expect(parseArgs(['bench', '--actual-global', AUTHORIZED_ACTUAL_GLOBAL_PATH]).actualGlobal).toBe(
      AUTHORIZED_ACTUAL_GLOBAL_PATH,
    );
  });

  test('is absent unless asked for', () => {
    expect(parseArgs(['bench']).actualGlobal).toBeUndefined();
  });

  test('requires a value', () => {
    expect(() => parseArgs(['bench', '--actual-global'])).toThrow(
      /--actual-global requires a value/,
    );
  });

  test('parsing does not validate the path — that decision belongs to the renderer', () => {
    expect(parseArgs(['bench', '--actual-global', '/tmp/anything']).actualGlobal).toBe('/tmp/anything');
  });
});
