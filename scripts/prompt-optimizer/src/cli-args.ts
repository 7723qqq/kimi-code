/**
 * Prompt Optimizer — command-line parsing.
 *
 * Kept out of `cli.ts` so it can be exercised without spawning a process.
 */

export interface CliArgs {
  readonly command?: string;
  readonly model?: string;
  readonly reps: number;
  readonly dryRun: boolean;
  readonly compare?: string;
  /** Repeatable: `--variant base --variant prune:Coding`. */
  readonly variants: readonly string[];
}

export const DEFAULT_REPS = 3;

/** Flags that take a value. */
const VALUE_FLAGS = ['model', 'reps', 'compare', 'variant', 'experiment', 'out'] as const;
/** Flags that do not. */
const BOOLEAN_FLAGS = ['dry-run', 'help'] as const;

const KNOWN_FLAGS: readonly string[] = [
  ...VALUE_FLAGS.map((f) => `--${f}`),
  ...BOOLEAN_FLAGS.map((f) => `--${f}`),
];

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliArgError';
  }
}

function usageLine(): string {
  return `Supported flags: ${KNOWN_FLAGS.join(', ')}`;
}

/**
 * Every occurrence of `--name value`, in order. A flag whose value is missing
 * or is itself a flag is an error rather than a silent `undefined`.
 */
function values(argv: readonly string[], name: string): string[] {
  const out: string[] = [];
  const flag = `--${name}`;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] !== flag) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new CliArgError(`${flag} requires a value.\n${usageLine()}`);
    }
    out.push(next);
    i += 1;
  }
  return out;
}

function firstValue(argv: readonly string[], name: string): string | undefined {
  return values(argv, name)[0];
}

/**
 * Reject anything the parser does not understand, so a typo is an error rather
 * than a silently ignored argument.
 */
function assertKnown(argv: readonly string[]): void {
  const valueFlags = new Set<string>(VALUE_FLAGS.map((f) => `--${f}`));
  const booleanFlags = new Set<string>(BOOLEAN_FLAGS.map((f) => `--${f}`));

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith('--')) {
      if (!valueFlags.has(token) && !booleanFlags.has(token)) {
        throw new CliArgError(`Unknown flag ${token}.\n${usageLine()}`);
      }
      // A value flag consumes its value, skip over it.
      if (valueFlags.has(token)) i += 1;
      continue;
    }
    // The first bare token is the command; any later one is stray.
    if (i !== 0) {
      throw new CliArgError(`Unexpected argument "${token}".\n${usageLine()}`);
    }
  }
}

export function parseArgs(argv: readonly string[]): CliArgs {
  assertKnown(argv);

  const repsRaw = firstValue(argv, 'reps');
  const reps = repsRaw === undefined ? DEFAULT_REPS : Number(repsRaw);

  return {
    command: argv[0],
    model: firstValue(argv, 'model'),
    reps: Number.isFinite(reps) && reps > 0 ? reps : DEFAULT_REPS,
    dryRun: argv.includes('--dry-run'),
    compare: firstValue(argv, 'compare'),
    variants: values(argv, 'variant'),
  };
}
