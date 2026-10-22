import { describe, expect, it, mock } from 'bun:test';

import { createStdinLineReader, readStdinText, type StdinSource } from '#/utils/process/stdin';

function createFakeStdin() {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const stdin = {
    on: mock((event: string, handler: (...args: unknown[]) => void) => {
      listeners.set(event, handler);
      return stdin;
    }),
    resume: mock(() => stdin),
    emit(event: string, payload?: unknown): void {
      listeners.get(event)?.(payload);
    },
  };
  return stdin;
}

describe('stdin helpers', () => {
  it('reads stdin text until end and trims the result', async () => {
    const stdin = createFakeStdin();

    const pending = readStdinText({ stdin: stdin as unknown as StdinSource });
    stdin.emit('data', Buffer.from(' hello world \n'));
    stdin.emit('end');

    await expect(pending).resolves.toBe('hello world');
    expect(stdin.resume).toHaveBeenCalledTimes(1);
  });

  it('rejects when the stream errors', async () => {
    const stdin = createFakeStdin();

    const pending = readStdinText({ stdin: stdin as unknown as StdinSource });
    stdin.emit('error', new Error('stdin closed'));

    await expect(pending).rejects.toThrow('stdin closed');
  });

  it('yields lines from the injected line reader over the given input', async () => {
    const stdin = createFakeStdin();
    const openLineReader = mock((_input: StdinSource) =>
      (async function* () {
        yield 'one';
        yield 'two';
      })(),
    );

    const lines: string[] = [];
    for await (const line of createStdinLineReader({
      stdin: stdin as unknown as StdinSource,
      openLineReader,
    })) {
      lines.push(line);
    }

    expect(lines).toEqual(['one', 'two']);
    expect(openLineReader).toHaveBeenCalledTimes(1);
    expect(openLineReader.mock.calls[0]![0]).toBe(stdin as unknown as StdinSource);
  });
});
