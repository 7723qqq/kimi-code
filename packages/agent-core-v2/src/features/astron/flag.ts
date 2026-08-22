import { type FlagDefinitionInput, registerFlagDefinition } from '#/app/flag/flagRegistry';

export const XUNFEI_CODING_PLAN_FLAG_ID = 'xunfei_coding_plan';
export const XUNFEI_CODING_PLAN_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_XUNFEI_CODING_PLAN';

export const xunfeiCodingPlanFlag: FlagDefinitionInput = {
  id: XUNFEI_CODING_PLAN_FLAG_ID,
  title: 'Astron (Xunfei coding plan)',
  description:
    'Show the Astron provider settings in /settings and enable the Astron login flow. The astron entry under [providers] stays functional regardless of this flag.',
  env: XUNFEI_CODING_PLAN_FLAG_ENV,
  default: true,
  surface: 'both',
};

registerFlagDefinition(xunfeiCodingPlanFlag);
