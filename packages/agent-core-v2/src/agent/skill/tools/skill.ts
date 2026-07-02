/**
 * SkillTool — invoke a registered skill.
 *
 * Collaboration tool that lets the LLM proactively invoke an inline
 * registered skill. Inline skills record their activation through the
 * owning agent; non-inline skill types are intentionally not model-invocable
 * in the v1 default runtime.
 *
 * The model-facing wrapping lives here on purpose: resolving the skill from
 * the catalog, the inline-only / `disableModelInvocation` gates, the `isError`
 * tool result, and the `prompt.steer` delivery into the *current* turn all
 * assume the caller is already inside a turn — which is exactly the edge a
 * tool runs at. `IAgentSkillService` keeps only the user-slash `activate`
 * primitive (it opens a fresh turn) and the shared activation recording.
 *
 * Anti-loop: `MAX_SKILL_QUERY_DEPTH` caps Skill→Skill recursion so a
 * skill that re-invokes itself (or chains into another) cannot recurse
 * without bound.
 */

import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ContextMessage, SkillActivationOrigin } from '#/agent/contextMemory';
import type { IAgentPromptService } from '#/agent/prompt';
import { renderModelToolSkillPrompt } from '#/agent/skill/prompt';
import type { BuiltinTool } from '#/agent/tool';
import type { ExecutableToolResult, ToolExecution } from '#/agent/tool';
import { isInlineSkillType } from '#/app/globalSkillCatalog/types';
import type { ISessionSkillCatalog } from '#/session/sessionSkillCatalog';
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

export interface SkillToolDeps {
  readonly catalog: ISessionSkillCatalog;
  readonly prompt: IAgentPromptService;
  readonly recordActivation: (origin: SkillActivationOrigin) => void;
}

export class SkillTool implements BuiltinTool<SkillToolInput> {
  readonly name = 'Skill';
  readonly description: string = renderPrompt(skillDescriptionTemplate, {
    MAX_SKILL_QUERY_DEPTH,
  });
  readonly parameters: Record<string, unknown> = toInputJsonSchema(SkillToolInputSchema);

  constructor(
    private readonly deps: SkillToolDeps,
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
    return new SkillTool(this.deps, {
      ...this.options,
      initialQueryDepth,
    });
  }

  private async execution(args: SkillToolInput): Promise<ExecutableToolResult> {
    return executeModelSkill(this.deps, args, this.options);
  }
}

export async function executeModelSkill(
  deps: SkillToolDeps,
  args: SkillToolInput,
  options: SkillToolOptions,
): Promise<ExecutableToolResult> {
  // Recursion hard cap. Once `currentDepth` has reached
  // MAX_SKILL_QUERY_DEPTH, firing another Skill call would push the
  // child to depth+1 which violates the invariant. Throw a structured
  // error (rather than a soft tool-error) so Runtime can distinguish
  // "LLM mis-dispatched" from "safety net fired".
  const currentDepth = options.initialQueryDepth ?? options.queryDepth ?? 0;
  if (currentDepth >= MAX_SKILL_QUERY_DEPTH) {
    throw new NestedSkillTooDeepError(MAX_SKILL_QUERY_DEPTH, args.skill);
  }

  await deps.catalog.ready;
  const skill = deps.catalog.catalog.getSkill(args.skill);
  if (skill === undefined) {
    return errorResult(`Skill "${args.skill}" not found in the current skill listing.`);
  }
  if (skill.metadata.disableModelInvocation === true) {
    // Keep the exact wording "can only be triggered by the user" so
    // contract audits and integration tests stay deterministic.
    return errorResult(
      `Skill "${args.skill}" can only be triggered by the user (model invocation is disabled).`,
    );
  }
  if (!isInlineSkillType(skill.metadata.type)) {
    return errorResult(
      `Skill "${skill.name}" is not an inline skill and cannot be invoked by the model in v1.`,
    );
  }

  const skillArgs = args.args ?? '';
  const trigger = currentDepth > 0 ? 'nested-skill' : 'model-tool';
  const origin: SkillActivationOrigin = {
    kind: 'skill_activation',
    activationId: randomUUID(),
    skillName: skill.name,
    skillArgs: skillArgs.length > 0 ? skillArgs : undefined,
    trigger,
    skillType: skill.metadata.type,
    skillPath: skill.path,
    skillSource: skill.source,
  };
  const skillContent = deps.catalog.catalog.renderSkillPrompt(skill, skillArgs);
  const message: ContextMessage = {
    role: 'user',
    content: [
      {
        type: 'text',
        text: renderModelToolSkillPrompt({
          skillName: skill.name,
          skillArgs,
          skillContent,
          skillSource: skill.source,
          skillDir: skill.dir,
          trigger,
        }),
      },
    ],
    toolCalls: [],
    origin,
  };
  deps.recordActivation(origin);
  deps.prompt.steer(message);
  return {
    output: `Skill "${skill.name}" loaded inline. Follow its instructions.`,
  };
}

function errorResult(message: string): ExecutableToolResult {
  return { isError: true, output: message };
}
