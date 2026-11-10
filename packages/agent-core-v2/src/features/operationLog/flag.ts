import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const OPERATION_LOG_FLAG_ID = 'operation_log';
export const OPERATION_LOG_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_OPERATION_LOG';

export const operationLogFlag: FlagDefinitionInput = {
  id: OPERATION_LOG_FLAG_ID,
  title: 'Operation Log',
  description:
    'Record foreground tool operations and enable repository view undo, redo, and restore.',
  env: OPERATION_LOG_FLAG_ENV,
  default: false,
  surface: 'both',
};

registerFlagDefinition(operationLogFlag);
