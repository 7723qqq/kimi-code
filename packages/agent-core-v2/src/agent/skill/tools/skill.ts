/**
 * SkillTool — invoke a registered skill.
 *
 * Collaboration tool that lets the LLM proactively invoke an inline
 * registered skill. Inline skills record their activation through the
 * owning agent; non-inline skill types are intentionally not model-invocable
 * in the v1 default runtime.
 *
 * Anti-loop: `MAX_SKILL_QUERY_DEPTH` caps Skill→Skill recursion so a
 * skill that re-invokes itself (or chains into another) cannot recurse
 * without bound.
 */

import { z } from 'zod';

import type { BuiltinTool } from '#/agent/tool';
import type { ExecutableToolResult, ToolExecution } from '#/agent/tool';
import type { IAgentSkillService } from '#/agent/skill/skill';
import { renderPrompt } from '#/_base/utils/render-prompt';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { matchesGlobRuleSubject } from '#/_base/tools/support/rule-match';
import skillDescriptionTemplate from './skill.md?raw';

export const MAX_SKILL_QUERY_DEPTH = 3;

export class NestedSkillTooDeepError extends Error {
  readonly skillName?: string;
  readonly depth: number;

  constructor(depth: number, skillName?: string) {
    const label = skillName !== undefined ? ` "${skillName}"` : '';
    super(
      `Nested skill invocation${label} exceeded the maximum depth of ${String(depth)} — refusing to recurse further.`,
    );
    this.name = 'NestedSkillTooDeepError';
    this.depth = depth;
    if (skillName !== undefined) this.skillName = skillName;
  }
}

export interface SkillToolInput {
  skill: string;
  args?: string;
}

export const SkillToolInputSchema: z.ZodType<SkillToolInput> = z.object({
  skill: z.string(),
  args: z.string().optional(),
});

export interface SkillToolOptions {
  /**
   * Current inline skill recursion depth.
   */
  readonly queryDepth?: number;
  /**
   * Alias for `queryDepth`. Kept so older call sites can seed the
   * inline recursion depth without knowing the internal field name.
   */
  readonly initialQueryDepth?: number;
}

export class SkillTool implements BuiltinTool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  constructor(
    private readonly skills: IAgentSkillService,
    private readonly options: SkillToolOptions = {},
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

  withInitialQueryDepth(initialQueryDepth: number): SkillTool {
    return new SkillTool(this.skills, {
      ...this.options,
      initialQueryDepth,
    });
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    // Recursion hard cap. Once `currentDepth` has reached
    // MAX_SKILL_QUERY_DEPTH, firing another Skill call would push the
    // child to depth+1 which violates the invariant. Throw a structured
    // error (rather than a soft tool-error) so Runtime can distinguish
    // "LLM mis-dispatched" from "safety net fired".
    const currentDepth = this.options.initialQueryDepth ?? this.options.queryDepth ?? 0;
    if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
      throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
    }

    return this.skills.activateFromModel({
      name: args.skill,
      args: args.args,
      queryDepth: currentDepth,
    });
  }
}
