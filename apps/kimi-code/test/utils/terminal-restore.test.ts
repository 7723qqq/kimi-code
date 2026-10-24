import { expect, it } from 'bun:test';

import { restoreTerminalModes } from '#/utils/terminal-restore';

function captureRestoreSequence(): string {
  const original = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write;
  try {
    restoreTerminalModes();
  } finally {
    process.stdout.write = original;
  }
  return chunks.join('');
}

it('leaves the alternate screen before tearing down the modes it enabled', () => {
  const sequence = captureRestoreSequence();

  expect(sequence).toContain('\u001B[?1049l');
  expect(sequence.indexOf('\u001B[?1049l')).toBe(0);
});

it('disables every mouse mode the alternate screen turns on, including focus reporting', () => {
  const sequence = captureRestoreSequence();

  // The alt screen enables 1000/1002/1003(/1004)/1006 as one burst; a crash
  // path that skipped focus reporting left the user's shell emitting
  // focus-in/focus-out reports after the process died.
  for (const mode of ['?1000l', '?1002l', '?1003l', '?1004l', '?1006l']) {
    expect(sequence).toContain(`\u001B[${mode}`);
  }
});

it('restores the cursor, autowrap, paste and keyboard protocols', () => {
  const sequence = captureRestoreSequence();

  expect(sequence).toContain('\u001B[?25h');
  expect(sequence).toContain('\u001B[?7h');
  expect(sequence).toContain('\u001B[?2004l');
  expect(sequence).toContain('\u001B[<u');
  expect(sequence).toContain('\u001B[>4;0m');
});

it('does not throw when the terminal is already gone', () => {
  const original = process.stdout.write.bind(process.stdout);
  const originalSetRawMode = process.stdin.setRawMode;
  process.stdout.write = ((): boolean => {
    throw new Error('EIO');
  }) as typeof process.stdout.write;
  process.stdin.setRawMode = (() => {
    throw new Error('EIO');
  }) as typeof process.stdin.setRawMode;
  try {
    expect(() => {
      restoreTerminalModes();
    }).not.toThrow();
  } finally {
    process.stdout.write = original;
    process.stdin.setRawMode = originalSetRawMode;
  }
});
