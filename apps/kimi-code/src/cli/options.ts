import { t } from '#/i18n';

export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

/** Environment variable that sets the default `-p` output format (flag wins). */
export const OUTPUT_FORMAT_ENV = 'KIMI_MODEL_OUTPUT_FORMAT';

const OUTPUT_FORMATS = ['text', 'stream-json'] as const;

function isOutputFormat(value: string): value is PromptOutputFormat {
  return (OUTPUT_FORMATS as readonly string[]).includes(value);
}

/**
 * Resolve the effective `-p` output format.
 *
 * Precedence: explicit `--output-format` flag → `KIMI_MODEL_OUTPUT_FORMAT` env
 * (prompt mode only) → `text`. The env var is ignored outside prompt mode so an
 * ambient value never affects interactive `kimi`. An invalid env value fails
 * fast via `OptionConflictError`.
 */
export function resolveOutputFormat(
  opts: Pick<CLIOptions, 'prompt' | 'outputFormat'>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PromptOutputFormat {
  if (opts.outputFormat !== undefined) return opts.outputFormat;
  if (opts.prompt === undefined) return 'text';
  const raw = (env[OUTPUT_FORMAT_ENV] ?? '').trim();
  if (raw.length === 0) return 'text';
  if (!isOutputFormat(raw)) {
    throw new OptionConflictError(
      `Invalid ${OUTPUT_FORMAT_ENV} value "${raw}". Expected one of: text, stream-json.`,
    );
  }
  return raw;
}

export interface CLIOptions {
  session: string | undefined;
  continue: boolean;
  yolo: boolean;
  auto: boolean;
  plan: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  prompt: string | undefined;
  skillsDirs: string[];
  addDirs?: string[];
}

export interface ValidatedOptions {
  options: CLIOptions;
  uiMode: UIMode;
}

export class OptionConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OptionConflictError';
  }
}

export function validateOptions(
  opts: CLIOptions,
  env: Readonly<Record<string, string | undefined>> = process.env,
): ValidatedOptions {
  const prompt = opts.prompt;
  const promptMode = prompt !== undefined;
  if (promptMode && prompt.trim().length === 0) {
    throw new OptionConflictError(t('cli.errors.promptEmpty'));
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError(t('cli.errors.modelEmpty'));
  }
  if (!promptMode && opts.outputFormat !== undefined) {
    throw new OptionConflictError(t('cli.errors.outputFormatPromptOnly'));
  }
  if (promptMode && opts.yolo) {
    throw new OptionConflictError(t('cli.errors.cannotCombinePromptAndYolo'));
  }
  if (promptMode && opts.auto) {
    throw new OptionConflictError(t('cli.errors.cannotCombinePromptAndAuto'));
  }
  if (promptMode && opts.plan) {
    throw new OptionConflictError(t('cli.errors.cannotCombinePromptAndPlan'));
  }
  if (promptMode && opts.session === '') {
    throw new OptionConflictError(t('cli.errors.sessionWithoutIdInPromptMode'));
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError(t('cli.errors.cannotCombineContinueAndSession'));
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError(t('cli.errors.cannotCombineYoloAndAuto'));
  }
  // Validate `KIMI_MODEL_OUTPUT_FORMAT` eagerly in prompt mode so a typo fails
  // fast through the friendly `error:` path instead of mid-run.
  if (promptMode) resolveOutputFormat(opts, env);
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
