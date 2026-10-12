import { once } from 'node:events';
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setImmediate as defer, setTimeout as delay } from 'node:timers/promises';

import { describe, expect, it } from 'vitest';

import {
  BufferedReadable,
  decodeTextWithErrors,
  globPatternToRegex,
  splitLinesKeepingTerminator,
} from '#/internal';
import { LocalKaos } from '#/local';
import { SSHKaos } from '#/ssh';

async function collectBytes(readable: AsyncIterable<Uint8Array | string>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    (async () => {
      await delay(timeoutMs);
      throw new Error(`timed out after ${timeoutMs}ms`);
    })(),
  ]);
}

describe('BufferedReadable', () => {
  it('preserves source backpressure until the consumer starts reading', () => {
    const source = new PassThrough({ highWaterMark: 64 * 1024 });
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(32 * 1024, 0x61);

    let writes = 0;
    let writeOk = true;
    while (writes < 20 && writeOk) {
      writeOk = source.write(chunk);
      writes++;
    }

    buffered.destroy();
    source.destroy();

    expect(writeOk).toBe(false);
    expect(writes).toBeLessThan(10);
  });

  it('stops pushing when its readable buffer reaches highWaterMark', async () => {
    const source = new PassThrough();
    const chunk = Buffer.alloc(32 * 1024, 0x62);

    for (let index = 0; index < 10; index++) {
      source.write(chunk);
    }
    source.end();

    const buffered = new BufferedReadable(source);
    buffered.read(0);
    await defer();

    expect(buffered.readableLength).toBeLessThanOrEqual(buffered.readableHighWaterMark);

    const output = await collectBytes(buffered);
    expect(output).toHaveLength(chunk.length * 10);
  });

  it('ends async iteration when the source closes without emitting end', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const outputPromise = collectBytes(buffered).then((output) => output.toString('utf8'));

    await defer();
    source.write('hello');
    await defer();
    source.destroy();

    await expect(withTimeout(outputPromise, 250)).resolves.toBe('hello');
  });

  it('propagates a source error through destroy()', async () => {
    // When the source emits an 'error' event, BufferedReadable must tear
    // itself down with the same error so consumers see the failure rather
    // than waiting forever for data.
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const boom = new Error('source boom');

    const errorReceived = new Promise<Error>((resolve) => {
      buffered.on('error', (err: Error) => {
        resolve(err);
      });
    });

    source.emit('error', boom);

    const received = await withTimeout(errorReceived, 250);
    expect(received).toBe(boom);
    expect(buffered.destroyed).toBe(true);
  });

  it('destroys the underlying source when the wrapper is destroyed', () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);

    buffered.destroy();

    expect(source.destroyed).toBe(true);
  });

  it('keeps an awaiting consumer in charge of the pacing instead of draining on the liveness timer', async () => {
    // Regression guard for e0bceecd22: the liveness timer used to resume the
    // source unconditionally, which cancelled the consumer's backpressure and
    // buffered the entire output (audit probe: 65 KiB -> 9.6 MiB in 1.5 s).
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(256 * 1024, 0x63);
    const total = 24;
    let peakBuffered = 0;
    let resolved = false;

    const produce = (async () => {
      for (let index = 0; index < total; index++) {
        if (!source.write(chunk)) {
          await once(source, 'drain');
        }
      }
      source.end();
    })();

    const consume = (async () => {
      // `for await` sets the stream flowing, so the consumer is "arrived";
      // the awaits between chunks are what used to lose the pacing race.
      for await (const _chunk of buffered) {
        peakBuffered = Math.max(peakBuffered, buffered.readableLength);
        await delay(200);
      }
      resolved = true;
    })();

    await delay(1500);
    const sampled = buffered.readableLength;
    const atCeiling = sampled >= 8 * 1024 * 1024;

    expect(resolved).toBe(false);
    expect(atCeiling).toBe(false);
    expect(peakBuffered).toBeLessThanOrEqual(2 * 1024 * 1024 + chunk.length);

    await withTimeout(Promise.all([produce, consume]), 30_000);
  });

  it('stops prefetching at the buffer ceiling when nobody reads at all', async () => {
    const source = new PassThrough();
    const buffered = new BufferedReadable(source);
    const chunk = Buffer.alloc(256 * 1024, 0x64);
    const total = 60; // 15 MiB, comfortably above the 8 MiB ceiling

    for (let index = 0; index < total; index++) {
      source.write(chunk);
    }

    await delay(1500);

    expect(buffered.readableLength).toBeLessThanOrEqual(8 * 1024 * 1024 + chunk.length);

    buffered.destroy();
    source.destroy();
  });
});

describe('decodeTextWithErrors', () => {
  it('decodes utf-16le content under strict mode', () => {
    // Covers the utf16le / ucs2 / ucs-2 alias branches that the readText
    // tests (which only exercise utf-8) never touch.
    const data = Buffer.from('hello', 'utf16le');
    expect(decodeTextWithErrors(data, 'utf16le')).toBe('hello');
  });

  it('accepts the ucs2 and ucs-2 encoding aliases', () => {
    const data = Buffer.from('hello', 'utf16le');
    expect(decodeTextWithErrors(data, 'ucs2')).toBe('hello');
    expect(decodeTextWithErrors(data, 'ucs-2' as BufferEncoding)).toBe('hello');
  });

  it('falls back to Buffer.toString for non-UTF encodings', () => {
    // hex / base64 / latin1 are lossless byte↔character mappings so `errors`
    // has no effect; the helper must take the non-TextDecoder branch.
    const data = Buffer.from([0x68, 0x69]); // 'hi' in latin1
    expect(decodeTextWithErrors(data, 'latin1')).toBe('hi');
    expect(decodeTextWithErrors(data, 'hex')).toBe('6869');
  });

  it('preserves valid U+FFFD when ignoring invalid utf-8 bytes', () => {
    const data = Buffer.concat([
      Buffer.from('A\uFFFDB', 'utf-8'),
      Buffer.from([0xff]),
      Buffer.from('C', 'utf-8'),
    ]);

    expect(decodeTextWithErrors(data, 'utf-8', 'ignore')).toBe('A\uFFFDBC');
  });

  it('matches Python ignore behavior for invalid utf-8 sequence boundaries', () => {
    const cases: Buffer[] = [
      Buffer.from([0xc2, 0x41]),
      Buffer.from([0xe0, 0xa0, 0x41]),
      Buffer.from([0xf0, 0x90, 0x80, 0x41]),
      Buffer.from([0xed, 0xa0, 0x80, 0x41]),
    ];

    for (const data of cases) {
      expect(decodeTextWithErrors(data, 'utf-8', 'ignore')).toBe('A');
    }
  });

  it('preserves valid U+FFFD when ignoring invalid utf-16le code units', () => {
    const data = Buffer.concat([
      Buffer.from('A\uFFFDB', 'utf16le'),
      Buffer.from([0x3d, 0xd8]), // lone high surrogate
      Buffer.from('C', 'utf16le'),
      Buffer.from([0xff]), // trailing half code unit
    ]);

    expect(decodeTextWithErrors(data, 'utf16le', 'ignore')).toBe('A\uFFFDBC');
  });

  it('matches Python ignore behavior for utf-16le surrogate boundaries', () => {
    const emojiPair = Buffer.from([0x3d, 0xd8, 0x00, 0xde]);
    expect(decodeTextWithErrors(emojiPair, 'utf16le', 'ignore')).toBe('\u{1F600}');

    const highThenNormalThenLow = Buffer.from([0x3d, 0xd8, 0x58, 0x00, 0x00, 0xdc]);
    expect(decodeTextWithErrors(highThenNormalThenLow, 'utf16le', 'ignore')).toBe('X');
  });
});

describe('globPatternToRegex additional cases', () => {
  it('converts ? to a single-character class that excludes /', () => {
    const regex = globPatternToRegex('f?o.txt', true);
    expect(regex.test('foo.txt')).toBe(true);
    expect(regex.test('fao.txt')).toBe(true);
    // ? must match exactly one character
    expect(regex.test('fo.txt')).toBe(false);
    // ? must not cross path segments
    expect(regex.test('f/o.txt')).toBe(false);
  });

  it('treats an unclosed [ as a literal bracket', () => {
    // Mirrors Python fnmatch/glob: a bare `[` with no closing `]` is
    // re-emitted as an escaped literal instead of starting a char class.
    const regex = globPatternToRegex('file[', true);
    expect(regex.test('file[')).toBe(true);
    expect(regex.test('file]')).toBe(false);
  });

  it('escapes regex metacharacters in the default branch', () => {
    // `+`, `.`, `(`, `)`, `$`, `^`, `|`, `{`, `}`, `\` must be escaped so
    // `a+b.c$d(e)` in a glob pattern matches that literal filename.
    const regex = globPatternToRegex('a+b.c$d(e)', true);
    expect(regex.test('a+b.c$d(e)')).toBe(true);
    // Without escaping, `+` would make `ab` match via one-or-more repetition.
    expect(regex.test('ab.c$d(e)')).toBe(false);
  });

  it('treats backslash as an escape character for the next literal', () => {
    // `\[` and `\]` should match literal brackets in the filename.
    const regex = globPatternToRegex('special \\[bracket\\].ts', true);
    expect(regex.test('special [bracket].ts')).toBe(true);
    expect(regex.test('special bracket.ts')).toBe(false);
  });

  it('escapes backslashes inside character classes to avoid an unterminated regex', () => {
    // A trailing backslash inside a glob char class (`[abc\\]`) would
    // escape the closing `]` in the resulting regex. We escape it so the
    // regex stays valid and the backslash is treated as a literal member.
    const regex = globPatternToRegex('file[abc\\].txt', true);
    expect(regex.test('filea.txt')).toBe(true);
    expect(regex.test('file\\.txt')).toBe(true);
    expect(regex.test('filez.txt')).toBe(false);
  });

  it('matches a literal `*` when it is backslash-escaped', () => {
    // `\*` is the only way to say "a literal asterisk" in a glob pattern.
    // Emitting an unescaped `*` turns it into a quantifier: `a\*` used to
    // match `aaa` and miss the literal `a*` file.
    const regex = globPatternToRegex('a\\*', true);
    expect(regex.test('a*')).toBe(true);
    expect(regex.test('aaa')).toBe(false);
    expect(regex.test('a')).toBe(false);
  });

  it('builds a valid regex for a pattern that is only an escaped wildcard', () => {
    // `\*` alone used to produce `/^*/` → `SyntaxError: nothing to repeat`.
    const regex = globPatternToRegex('\\*', true);
    expect(regex.test('*')).toBe(true);
    expect(regex.test('abc')).toBe(false);
    expect(regex.test('')).toBe(false);

    const question = globPatternToRegex('\\?', true);
    expect(question.test('?')).toBe(true);
    expect(question.test('a')).toBe(false);
    expect(question.test('')).toBe(false);
  });
});

describe('globPatternToRegex', () => {
  it('treats [!...] as a negated character class', () => {
    const regex = globPatternToRegex('[!a].txt', true);

    expect(regex.test('a.txt')).toBe(false);
    expect(regex.test('b.txt')).toBe(true);
  });

  it('treats ^ as a literal character inside glob character classes', () => {
    const regex = globPatternToRegex('[^a].txt', true);

    expect(regex.test('^.txt')).toBe(true);
    expect(regex.test('a.txt')).toBe(true);
    expect(regex.test('b.txt')).toBe(false);
  });

  describe('glob semantic compatibility (Python parity)', () => {
    it('treats brace expansion syntax as literal characters', () => {
      const regex = globPatternToRegex('*.{js,ts}', true);

      expect(regex.test('file.js')).toBe(false);
      expect(regex.test('file.ts')).toBe(false);
      expect(regex.test('file.{js,ts}')).toBe(true);
    });

    it('treats leading ^ as a literal character inside character classes', () => {
      const regex = globPatternToRegex('[^a].txt', true);

      expect(regex.test('^.txt')).toBe(true);
      expect(regex.test('a.txt')).toBe(true);
      expect(regex.test('b.txt')).toBe(false);
    });

    it('uses ! for character class negation', () => {
      const regex = globPatternToRegex('[!a].txt', true);

      expect(regex.test('b.txt')).toBe(true);
      expect(regex.test('a.txt')).toBe(false);
    });

    it('matches hidden files with dot-prefixed patterns', () => {
      const regex = globPatternToRegex('.*', true);

      expect(regex.test('.hidden')).toBe(true);
      expect(regex.test('.config')).toBe(true);
    });

    it.skip('Python treats **/foo.txt as recursive; current helper is segment-based and does not implement zero-or-more directories', () => {
      const regex = globPatternToRegex('**/foo.txt', true);

      expect(regex.test('foo.txt')).toBe(true);
      expect(regex.test('a/foo.txt')).toBe(true);
      expect(regex.test('a/b/foo.txt')).toBe(true);
    });

    it('keeps single-star matching to a single path segment', () => {
      const regex = globPatternToRegex('*/foo.txt', true);

      expect(regex.test('a/foo.txt')).toBe(true);
      expect(regex.test('foo.txt')).toBe(false);
      expect(regex.test('a/b/foo.txt')).toBe(false);
    });
  });
});

describe('readLines semantics shared by LocalKaos and SSHKaos', () => {
  // Same inputs, both implementations: the yielded line sequences must agree
  // byte for byte. `splitLinesKeepingTerminator` is the shared definition of a
  // line — terminators kept, only LF splits, a lone CR is content, empty file
  // yields nothing — so the helper assertions here cover both.
  const FIXTURES: Array<[string, string]> = [
    ['multiline LF', 'line1\nline2\nline3\n'],
    ['no trailing newline', 'line1\nline2'],
    ['single line', 'only'],
    ['single newline', '\n'],
    ['empty', ''],
    ['crlf', 'a\r\nb\r\n'],
    ['lone cr', 'a\rB\n'],
    ['cr only', 'a\rb'],
  ];

  function fakeSshKaos(content: Buffer): SSHKaos {
    const sftp = {
      readFile(_path: string, cb: (err: Error | null, data: Buffer) => void): void {
        cb(null, content);
      },
    };
    const instance = Object.create(SSHKaos.prototype) as SSHKaos;
    const internals = instance as unknown as { _sftp: unknown; _cwd: string; _home: string };
    internals._sftp = sftp;
    internals._cwd = '/';
    internals._home = '/';
    return instance;
  }

  async function collect(generator: AsyncGenerator<string>): Promise<string[]> {
    const lines: string[] = [];
    for await (const line of generator) {
      lines.push(line);
    }
    return lines;
  }

  it('yields identical line sequences from LocalKaos and SSHKaos', async () => {
    const kaos = await LocalKaos.create();
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'kaos-lines-')));
    try {
      for (const [name, content] of FIXTURES) {
        const path = join(dir, `${name.replaceAll(' ', '-')}.txt`);
        await writeFile(path, content, 'utf-8');

        const fromLocal = await collect(kaos.readLines(path));
        const fromSsh = await collect(fakeSshKaos(Buffer.from(content, 'utf-8')).readLines(path));
        const fromHelper = [...splitLinesKeepingTerminator(content)];

        expect(fromLocal, name).toEqual(fromHelper);
        expect(fromSsh, name).toEqual(fromLocal);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
