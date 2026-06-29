import { renderPrompt } from "#/_base/utils/render-prompt";
import type { ExecutableTool, ExecutableToolResult, ToolExecution } from '#/_base/tools';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import type { IAgentSkillService } from '../skill';
import {
  MAX_SKILL_QUERY_DEPTH,
  NestedSkillTooDeepError,
  SkillToolInputSchema,
  type SkillToolInput,
} from './skill';
import skillDescriptionTemplate from './skill.md?raw';

export interface ModelSkillToolOptions {
  readonly queryDepth?: number;
  readonly initialQueryDepth?: number;
}

export class ModelSkillTool implements ExecutableTool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  constructor(
    private readonly skills: IAgentSkillService,
    private readonly options: ModelSkillToolOptions = {},
  ) {}

  resolveExecution(args: SkillToolInput): ToolExecution {
    return {
      description: `Invoke skill ${args.skill}`,
      display: { kind: 'skill_call', skill_name: args.skill, args: args.args },
      approvalRule: this.name,
      matchesRule: (ruleArgs) => matchesGlobRuleSubject(ruleArgs, args.skill),
      execute: () => this.execution(args),
    };
  }

  withInitialQueryDepth(initialQueryDepth: number): ModelSkillTool {
    return new ModelSkillTool(this.skills, {
      ...this.options,
      initialQueryDepth,
    });
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    const queryDepth = this.options.initialQueryDepth ?? this.options.queryDepth ?? 0;
    if (queryDepth >= MAX_SKILL_QUERY_DEPTH) {
      throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
    }
    return this.skills.activateFromModel({
      name: args.skill,
      args: args.args,
      queryDepth,
    });
  }
}
