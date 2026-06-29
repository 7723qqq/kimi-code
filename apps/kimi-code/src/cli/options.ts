export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';
export type PromptInputFormat = 'text' | 'stream-json';

export interface CLIOptions {
  session: string | undefined;
  continue: boolean;
  yolo: boolean;
  auto: boolean;
  plan: boolean;
  model: string | undefined;
  outputFormat: PromptOutputFormat | undefined;
  inputFormat?: PromptInputFormat | undefined;
  finalMessageOnly?: boolean;
  quiet?: boolean;
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

export function validateOptions(opts: CLIOptions): ValidatedOptions {
  const prompt = opts.prompt;
  const hasPrompt = prompt !== undefined;
  // Prompt mode is entered by `--prompt`, by `--input-format` (the prompt is
  // then read from stdin instead of the flag), or by `--quiet`.
  const promptMode = hasPrompt || opts.inputFormat !== undefined || opts.quiet === true;
  if (hasPrompt && prompt.trim().length === 0) {
    throw new OptionConflictError('Prompt cannot be empty.');
  }
  if (opts.model !== undefined && opts.model.trim().length === 0) {
    throw new OptionConflictError('Model cannot be empty.');
  }
  if (!promptMode && opts.outputFormat !== undefined) {
    throw new OptionConflictError('Output format is only supported in prompt mode.');
  }
  if (!promptMode && opts.finalMessageOnly) {
    throw new OptionConflictError('Final-message-only output is only supported in prompt mode.');
  }
  // `--quiet` is shorthand for `--output-format text --final-message-only`, so a
  // conflicting explicit output format is rejected.
  if (opts.quiet === true && opts.outputFormat !== undefined && opts.outputFormat !== 'text') {
    throw new OptionConflictError('Quiet mode implies --output-format text.');
  }
  if (hasPrompt && opts.inputFormat !== undefined) {
    throw new OptionConflictError(
      'Cannot combine --prompt with --input-format; the prompt is read from stdin.',
    );
  }
  if (promptMode && opts.yolo) {
    throw new OptionConflictError('Cannot combine --prompt with --yolo.');
  }
  if (promptMode && opts.auto) {
    throw new OptionConflictError('Cannot combine --prompt with --auto.');
  }
  if (promptMode && opts.plan) {
    throw new OptionConflictError('Cannot combine --prompt with --plan.');
  }
  if (promptMode && opts.session === '') {
    throw new OptionConflictError('Cannot use --session without an id in prompt mode.');
  }
  if (opts.continue && opts.session !== undefined) {
    throw new OptionConflictError('Cannot combine --continue, --session.');
  }
  if (opts.yolo && opts.auto) {
    throw new OptionConflictError('Cannot combine --yolo with --auto.');
  }
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
