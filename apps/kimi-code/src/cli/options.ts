import { t } from '#/i18n';

export type UIMode = 'shell' | 'print';
export type PromptOutputFormat = 'text' | 'stream-json';

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

export function validateOptions(opts: CLIOptions): ValidatedOptions {
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
  return { options: opts, uiMode: promptMode ? 'print' : 'shell' };
}
