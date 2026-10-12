/**
 * Yes/no confirmation for CLI sub-commands.
 *
 * `readline/promises`'s `question()` only settles on a `line` event: when stdin
 * is at EOF with no pending line (cron/CI, `ssh host kimi export`,
 * `< /dev/null`) the pending promise never settles and the command hangs
 * forever with no output. The input stream's `end` event is raced in as an
 * explicit third answer instead.
 *
 * The EOF resolution is deferred by one macrotask (`setImmediate`): `end` fires
 * *before* readline emits the lines it already buffered, so resolving `'eof'`
 * synchronously would reject a clearly visible `echo y | kimi export` and would
 * shadow the last line of a multi-line answer.
 */

import { createInterface } from 'node:readline/promises';

/** Answer to a yes/no prompt: `'eof'` means stdin ended before an answer. */
export type ConfirmPromptAnswer = 'yes' | 'no' | 'eof';

export interface ConfirmPromptIo {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
}

export async function promptYesNo(
  question: string,
  io: ConfirmPromptIo = { input: process.stdin, output: process.stderr },
): Promise<ConfirmPromptAnswer> {
  const rl = createInterface({ input: io.input, output: io.output });
  try {
    const answered = rl.question(question).then((answer) => {
      const trimmed = answer.trim().toLowerCase();
      return trimmed === '' || trimmed === 'y' || trimmed === 'yes' ? 'yes' : 'no';
    });
    const ended = new Promise<ConfirmPromptAnswer>((resolve) => {
      io.input.once('end', () => {
        setImmediate(() => {
          resolve('eof');
        });
      });
    });
    return await Promise.race([answered, ended]);
  } finally {
    rl.close();
  }
}
