import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { getMaxListeners } from 'node:events';

import { type IDisposable } from '#/_base/di/lifecycle';
import { Event } from '#/_base/event';
import { isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { type AgentContext } from '#/agent/agentContext/agentContext';
import { type LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import { type ContextMessage, type PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { type Turn } from '#/agent/loop/loop';
import { IAgentLoopService } from '#/agent/loop/loop';
import { TurnStarted, TurnStepCompleted } from '#/agent/loop/turnEvents';
import type { CacheBreakObservation } from '#/agent/usage/cacheBreak';
import { TurnEnded } from '#/agent/loop/turnOps';
import { agentContextOf } from '#/agent/scopeContext/scopeContext';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IEventBus } from '#/app/event/eventBus';
import { IPluginService } from '#/app/plugin/plugin';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentGoalService } from '#/features/goal/goalService';
import { IAgentProfileService } from '#/index';
import { APIProviderRateLimitError } from '#/llm-adapter/contract/errors';
import { type ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import { type ExecutableTool } from '#/tool/toolContract';
import { createAgentMachine } from '#human/agent/machine';
import { type ToolCall } from '#human/llm/message';
import { emptyUsage } from '#human/llm/usage';
import { createActor } from '#human/xstate2';
import { waitForAssertion } from '#test/helpers/waitFor';

import { TurnStepInterrupted } from '../../../src/agent/loop/turnEvents';
import { TurnStepStarted } from '../../../src/agent/loop/turnEvents';
import { ThinkingDelta } from '../../../src/agent/loop/turnEvents';
import { AssistantDelta } from '../../../src/agent/loop/turnEvents';
import { type AgentScopeCreatedEvent } from '../../../src/session/agentLifecycle/agentLifecycle';
import { IAgentLifecycleService } from '../../../src/session/agentLifecycle/agentLifecycle';
import { stubPluginService } from '../../app/plugin/stubs';
import { type TelemetryRecord, recordingTelemetry } from '../../app/telemetry/stubs';
import {
  createTestAgent,
  InMemoryWireRecordPersistence,
  wireRecordPersistenceServices,
  type LegacyGenerateResult,
  type TestAgentContext,
  type TestAgentOptions,
} from '../../harness';
import { agentService } from '../../harness/agent';
import { appService } from '../../harness/agent';
import { sessionService } from '../../harness/agent';
import { permissionModeServices } from '../../harness/agent';
import { requesterFromGenerateFn } from '../../harness/index';
import { renderSnapshot } from '../../harness/snapshots';
import { submitPromptTurn } from './stubs';

type GenerateFn = NonNullable<TestAgentOptions['generate']>;

describe('Agent loop', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;
  let profile: IAgentProfileService;

  beforeEach(async () => {
    ctx = createTestAgent();
    await ctx.restorePersisted();
    loop = ctx.get(IAgentLoopService);
    profile = ctx.get(IAgentProfileService);
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  it('runs a text-only agent turn from prompt to completion', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse(
      { type: 'think', think: '<think-1>' },
      { type: 'text', text: '<text-1>' },
      { type: 'think', think: '' },
      { type: 'text', text: '<text-2>' },
    );
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(renderSnapshot(await ctx.untilTurnEnd())).toMatchInlineSnapshot(`
      "[wire] tools.set_active_tools      { "agentId": "main", "names": [], "time": "<time>" }
      [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Hello" } ], "createdAt": "<time>" }
      [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
      [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Hello" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] agent.message.appended      { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.started          { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
      [wire] tool_select.initialized     { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task in its own context.\\n\\nDo not launch a subagent unless the user explicitly asks for one, including delegation, parallel agents, or a named agent type. Explicit instructions in AGENTS.md or a skill, and user-enabled multi-agent modes, also authorize launching. Large or multi-part tasks and requests for depth, thoroughness, research, or investigation do not; do that work yourself. Agent type descriptions below guide selection only after authorization. Resuming already-authorized work needs no new request. Each subagent starts cold and re-derives context, costing time and tokens.\\n\\nWriting the prompt:\\n- Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups: put exact paths or commands you already know in the prompt.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nBackground agent execution is disabled for this agent. Do not set \`run_in_background=true\` — any call that sets it is rejected before the subagent launches. Run every subagent in the foreground and wait for its result.\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, WebSearch, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, ExitSpecMode, Glob, Grep, Read, run_code, Skill, SnapshotList, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out. Pass a flat object: keys are existing \`agent_id\` strings (as reported in a previous swarm's \`<subagent agent_id=\\"...\\">\` output), values are the continuation prompt for that subagent (usually \`\\"continue\\"\` if no extra information is needed). For example, with \`resume_agent_ids\` set to \`{\\"agent-coder-1\\": \\"continue\\", \\"agent-coder-2\\": \\"focus on the imports\\"}\`, AgentSwarm resumes those two existing subagents and spawns no new ones. You may combine \`resume_agent_ids\` with \`items\` to resume some and spawn others; resumed agents always run before fresh spawns and keep their original \`subagent_type\` and model. \`resume_agent_ids\` is a flat record — do not pass an array or a list of \`{item, prompt}\` objects, and do not use \`{{item}}\` as a key: that placeholder only applies to \`prompt_template\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Flat object: keys are existing subagent agent_id strings (from a previous swarm's \`<subagent agent_id=\\"...\\">\` result), values are the continuation prompt for that subagent (e.g. \\"continue\\"). Resumed subagents run before new item-based subagents. Do not pass an array or a list of {item, prompt} objects.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- Group related questions into one call to minimize interruptions\\n- List a recommended option first\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "description": "Whether the user can select multiple options.", "type": "boolean" }, "multiSelect": { "description": "Deprecated camelCase alias of multi_select; prefer multi_select.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, and anything the dedicated tools do not cover.\\n\\n- \`ls\` / \`find\` (list files) → \`Glob\`\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nEach call runs in a fresh shell: variables and \`cd\` do not persist, so pass \`cwd\` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with \`Command failed with exit code: N\`. Do not run interactive commands or commands that never exit. Set \`timeout\` for possibly long-running commands. A command that hits its timeout is killed.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n- Use \`&&\` for commands that depend on each other. Issue independent read-only commands (separate \`git show\`, \`ls\`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with \`echo\` separators.\\n- Avoid \`..\` paths outside the working directory, and do not modify files outside it unless explicitly instructed.\\n- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n- Command availability depends on the host; run \`which <command>\` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the \`gh\` CLI when installed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable goal that the runtime pursues across multiple turns. Call it only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one. Do not create a goal for greetings, ordinary questions, or requests without a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion first; if they clearly insist after you warn them that the wording is vague or risky, create the goal anyway. Include \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise and reference long task descriptions by file path. Creating fails if a goal already exists; pass \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued later in this session, recurring or once.\\n\\nWhen the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: \\"around 9\\" → \`57 8 * * *\`, \\"hourly\\" → \`7 * * * *\`.\\n\\nTasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with \`coalescedCount\` > 1: act on the latest state once. The final fire carries \`stale=\\"true\\"\`, so call CronCreate again with the same \`cron\` and \`prompt\` if the schedule is still wanted.\\n\\nUsers cannot manage cron tasks themselves: after creating one, tell the user its \`id\` and that they can ask you to cancel or change it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a live cron task by its \`id\`. Fired one-shots and expired tasks are already gone; if an id is not found, call CronList instead of retrying it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List this session's cron tasks. Read-only. \`stale: true\` marks a recurring task whose next fire is its last. After a context compaction, call this instead of guessing ids.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "EnterSpecMode", "description": "Use this tool when the user asks for a spec, or when a change is large enough that agreeing on the contract before writing code is worth a detour.\\n\\nGetting sign-off on a written spec before implementation prevents wasted effort: the user reviews requirements, design and tasks once, then you execute against that agreed contract instead of guessing.\\n\\n**What spec mode is for.** Plan mode produces a throwaway plan for one session. Spec mode writes documents that live in the repository, get committed alongside the code, and are read again by later sessions and teammates. Reach for it when the artifact should outlive this conversation.\\n\\n**Your workflow — write all four before calling ExitSpecMode:**\\n\\n1. Investigate with read-only tools (Read, Grep, Glob). Use Bash only when needed.\\n2. Write \`requirements.md\` — what to build. State the goal, who it is for, the boundaries, and explicitly what is *out of scope*. A requirement the user did not imply is a defect, not initiative.\\n3. Write \`design.md\` — how to build it. Name the concrete approach (files, functions, contracts), the technical constraints, and the trade-offs you rejected along with why.\\n4. Write \`tasks.md\` — how to verify it. Split the work into tasks small enough to finish and to check independently.\\n5. Call ExitSpecMode for approval. Nothing outside the spec directory can be written until the user approves.\\n\\n**Tasks must carry acceptance criteria.** A task that says \\"implement the export endpoint\\" cannot be verified. Write what must hold when it is done — the specific error, status, field, threshold or boundary that proves it. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is. Prefer criteria you can check by running something over criteria that need judgement.\\n\\n**Do not restate the project's global rules.** Conventions that already live in AGENTS.md / DEVELOP.md apply everywhere and belong there, not in a spec about one change. Reference them; do not copy them. A spec that repeats global rules goes stale the moment those rules move.\\n\\n**Keep the user in the loop on genuinely open questions.** If the requirements leave a decision that materially changes the design, ask before writing — an invented requirement buried in a spec is harder to notice than a question.\\n\\n**Constraints:**\\n- Writes are restricted to the spec directory until the user approves the spec; other edits are rejected. Call ExitSpecMode when the documents are ready.\\n- Do not create \`progress.md\` while in spec mode — it records implementation progress later, and this mode produces the three required documents above. Writes are not limited to those three: any file inside the spec directory is writable, so \`progress.md\` is accepted if the spec or the user calls for it.\\n- Plan, spec, swarm and tower modes are mutually exclusive. Entering spec mode leaves whichever of the others was active; the result names it, if any. You do not need to exit the other mode yourself.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.\\n\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitSpecMode", "description": "Use this tool when you are in spec mode and have finished writing the spec documents, and are ready for the user to review them.\\n\\n## How This Tool Works\\n- The requirements, design and tasks documents are read from the spec directory, not passed as parameters.\\n- The user sees all three when they review. In auto permission mode the tool exits spec mode without asking.\\n- All three must be non-empty. A missing or empty document is rejected, naming the file you still have to write.\\n\\n## When to Use\\nUse it only when the spec is genuinely ready to be approved. It does not verify the quality of what you wrote — it checks that the three documents exist and hands them to the user.\\n\\n## What a good spec contains\\n- **Requirements**: the goal, who it is for, the boundaries, and what is explicitly out of scope. A requirement the user did not imply is a defect.\\n- **Design**: the concrete approach — real files, functions and contracts — plus the trade-offs you rejected and why.\\n- **Tasks**: work split small enough to finish and to check, each with acceptance criteria. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is.\\n\\n## Multiple Approaches\\nIf the design document leaves a genuine choice between approaches, pass them via the \`options\` parameter so the user can pick which one to execute. Each option must correspond to an approach the design document actually describes.\\n\\n## After Approval\\nSpec mode ends and normal tool permissions return. Work through the tasks document, and record progress in the spec's progress file as you go. The progress file is a working note for whoever reads the spec next; it is not gated by this tool.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the design document leaves a genuine choice between approaches, list them here so the user can pick which one to execute. Provide up to 3 options; 2-3 distinct approaches work best. Each option must correspond to an approach the design document actually describes. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, budgets with what remains of each, and the terminal reason once it has stopped. Returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — recursive from the search root; \`src/*.ts\` — only directly inside \`src/\`\\n- \`src/**/*.ts\` — recursive beneath \`src/\`\\n- \`*.{ts,tsx}\` and \`{src,test}/**/*.ts\` — brace expansion\\n\\nFollow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.\\n\\nAvoid broad searches in dependency or build-output directories, especially with \`include_ignored\`; prefer a narrow \`path\` or \`pattern\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files are searched by default.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Knowledge", "description": "Use this tool to interact with the local knowledge base — a structured store of coding standards, pitfalls, architecture decisions, and workflow rules for the current project.\\n\\nThe knowledge base is automatically queried before each turn to inject relevant standards. You can also actively search, add, confirm, or reject entries.\\n\\nSub-commands (pass as the \`action\` parameter):\\n- \`search\`: Find entries relevant to a query, file path, or tags\\n- \`add\`: Record a new standard or pitfall discovered during work\\n- \`confirm\`: Upgrade an AI-learned entry to confirmed (confidence → 1.0)\\n- \`reject\`: Remove an incorrect or outdated entry\\n\\nWhen to use:\\n- After discovering a non-obvious constraint or convention: use \`add\`\\n- When the user corrects you and the correction is a reusable rule: use \`add\`\\n- When reviewing existing entries: use \`search\`\\n- To validate or dismiss auto-learned entries: use \`confirm\` or \`reject\`\\n\\nDo NOT use this tool for:\\n- General knowledge or facts (only project-specific standards)\\n- Temporary per-session preferences\\n- Information already in AGENTS.md (avoid duplication)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "add", "confirm", "reject" ] }, "query": { "type": "string" }, "scope": { "type": "string" }, "tags": { "type": "string" }, "id": { "type": "string" }, "title": { "type": "string" }, "category": { "type": "string", "enum": [ "coding-style", "pitfall", "architecture", "workflow" ] }, "content": { "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Memory", "description": "Search and manage persistent memory across sessions.\\n\\nMemory files are markdown documents stored under \`~/.kimi-code/memory/\`, organized by scope:\\n- **global** — cross-project knowledge (architecture decisions, coding standards, tool configs)\\n- **project** — project-specific knowledge tied to the current working directory\\n- **session** — session-specific notes and context\\n\\n## Actions\\n\\n### \`search\`\\nFull-text search over all memory entries. Returns matching snippets with scope and relevance score. Requires \`query\`.\\n\`\`\`\\nMemory({ action: \\"search\\", query: \\"authentication pattern\\" })\\n\`\`\`\\n\\n### \`read\`\\nRead a specific memory file by its relative path.\\n\`\`\`\\nMemory({ action: \\"read\\", path: \\"global/auth-pattern.md\\" })\\n\`\`\`\\n\\n### \`write\`\\nCreate or update a memory file. The \`scope\` determines where it lives:\\n- \`global\` — stored at \`~/.kimi-code/memory/global/\`\\n- \`project\` — stored at \`~/.kimi-code/memory/projects/<projectId>/\`\\n- \`session\` — stored at \`~/.kimi-code/memory/sessions/<sessionId>/\`\\n\\n\`\`\`\\nMemory({\\n  action: \\"write\\",\\n  scope: \\"project\\",\\n  path: \\"auth-pattern\\",\\n  content: \\"# Authentication Pattern\\\\n\\\\nUse JWT with refresh tokens...\\"\\n})\\n\`\`\`\\n\\n### \`list\`\\nList all memory files, optionally filtered by scope.\\n\`\`\`\\nMemory({ action: \\"list\\", scope: \\"global\\" })\\n\`\`\`\\n\\n### \`delete\`\\nDelete a memory file by its relative path.\\n\`\`\`\\nMemory({ action: \\"delete\\", path: \\"global/old-note.md\\" })\\n\`\`\`\\n\\n### \`log\`\\nList the memory repository's recent commits, newest first, each with its short\\nsha, date and message. Use it to pick a revision before \`revert\`.\\n\`\`\`\\nMemory({ action: \\"log\\" })\\n\`\`\`\\n\\n### \`revert\`\\nRoll one memory commit back. Takes the full \`sha\` reported by \`log\`; a short sha\\nis rejected. The search index is resynchronised from disk before the call\\nreturns, so a reverted file stops matching immediately.\\n\`\`\`\\nMemory({ action: \\"revert\\", sha: \\"<full sha>\\" })\\n\`\`\`\\n\\n## Scope semantics\\n\\n- \`search\` covers **every** project and session unless \`scope\` is given; pass\\n  \`scope\` to restrict it to the current project, the global scope, or this\\n  session.\\n- \`write\` defaults to \`project\` and never writes outside the scope you name.\\n- \`list\` defaults to everything; with \`scope\` it returns only that scope of the\\n  current project or session.\\n\\n\`project\` scope is keyed by the repository when there is one: the identity comes\\nfrom the \`origin\` remote first, then from the repository root, and only falls\\nback to the working directory path outside git. A repository with an \`origin\`\\nremote keeps the same project bucket after re-cloning, renaming or moving; a\\nrepository without one keeps it when you work from any directory inside it.\\n\\n## Git memory interaction\\n\\nWhen the \`git_memory\` experiment is enabled, \`write\` additionally requires the\\ncontent to cite a real commit: a 7–40 character hex string that \`git cat-file\`\\nresolves in the session working directory or in the memory repository. A write\\nwithout one is rejected. With the experiment on, every write and delete is\\ncommitted to that repository (\`remember:\`, \`update:\`, \`forget:\`), which is what\\n\`log\` lists and \`revert\` rolls back. With the experiment off, no such\\nrequirement applies and nothing is committed.\\n\\n## When to use\\n\\n- **Before starting a task** — search memory for relevant context from past sessions\\n- **After learning something important** — write it to memory for future reference\\n- **When you encounter a pattern or decision** — persist it so future you doesn't rediscover it\\n- **When debugging** — search for similar past issues and their resolutions\\n\\nMemory persists across sessions and projects. Use it to build up institutional knowledge.\\n\\nThe search index is rebuilt from the files on disk at most once every ten minutes, so\\na file edited outside this tool shows up in \`search\` and \`list\` within that window\\nrather than immediately.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "read", "write", "list", "delete", "log", "revert" ], "description": "The memory operation to perform. Required." }, "query": { "description": "Search query (for \`search\` action).", "type": "string" }, "path": { "description": "Memory file path (for \`read\`, \`write\`, \`delete\`). Can include or omit \`.md\` extension. For \`read\`/\`delete\`, this is the full relative path (e.g. \`global/auth.md\`). For \`write\`, this is the filename within the chosen scope.", "type": "string" }, "scope": { "description": "Memory scope (for \`search\`, \`write\`, \`list\`). \`search\` defaults to every scope of every project; \`write\` defaults to \`project\`; \`list\` defaults to all scopes.", "type": "string", "enum": [ "global", "project", "session" ] }, "content": { "description": "Markdown content (for \`write\` action).", "type": "string" }, "sha": { "description": "Memory repository commit sha (for \`revert\` action).", "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "PowerShell", "description": "Execute a Windows PowerShell script natively (PowerShell 7 \`pwsh\` when available, otherwise Windows PowerShell 5.1). The script runs as a direct PowerShell process — it is not routed through bash.\\n\\n**When to use this instead of Bash:**\\n\\n- The task is inherently PowerShell: Windows registry, services, scheduled tasks, winget, WinGet/MSI installs, COM/WinRM, Windows event logs, NTFS ACLs, certificate store.\\n- You need PowerShell cmdlets or .NET types (\`Get-Service\`, \`Get-ItemProperty\`, \`[System.*]\`).\\n- You are on Windows and about to run \`powershell.exe\` / \`pwsh\` from the Bash tool — do not: the bash→native-PowerShell bridge re-encodes output and corrupts non-ASCII text. Use this tool instead; output is always decoded as UTF-8.\\n\\n**When to keep using Bash:** anything with POSIX shell semantics — pipes over coreutils, git, package managers of the project, build/test runners. File reads/edits/searches belong to \`Read\` / \`Edit\` / \`Glob\` / \`Grep\` regardless of platform.\\n\\n**Behavior:**\\n\\n- The script is passed as a single \`-EncodedCommand\` payload, so quoting and encoding are handled for you; write ordinary PowerShell script text. Interactive input is not supported.\\n- The session runs with \`-NoProfile -NonInteractive\`. Output encoding is pinned to UTF-8, so non-ASCII text (including Chinese) comes back clean.\\n- stdout and stderr are combined and returned as a string. The output may be truncated if it is too long. A non-zero exit ends the result with a \`Command failed with exit code: N\` line; a script killed by its timeout or interrupted by the user ends with its own message instead.\\n- Each call runs in a fresh process: variables and location do not persist between calls. To run in a particular directory, pass the \`cwd\` argument.\\n- Foreground calls default to 60s and allow up to 300s; a foreground call that hits its timeout is moved to the background instead of being killed.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Safety:** do not use this tool to escape the working directory, to modify files outside of it unless instructed, or to run commands that require superuser privileges unless explicitly instructed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The PowerShell script to execute." }, "cwd": { "description": "The working directory in which to run the script. When omitted, the script runs in the session's working directory.", "type": "string" }, "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991, "description": "Optional timeout in seconds for the script to execute." }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the script as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the script. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Read", "description": "Read a text file from the active environment's filesystem. Do not fully trust comments and documentation.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Output is \`<line-number>\\\\t<content>\` per line. A \`<system>\` status block may follow; it is not part of the file.\\n- Results are bounded by \`max_chars\`: 100000 by default, up to 500000, and by about 500000 divided by four estimated tokens.\\n- If the status block reports an incomplete range, continue with its \`Next Read\` arguments exactly. Do not answer from a partial page when the task requires the remaining content.\\n- **Images and videos** (max 100MB) are sent to the model as multimodal media instead of text; this requires a model with the matching vision capability (\`image_in\` / \`video_in\`). \`region\` and \`full_resolution\` apply only to images; \`line_offset\` and \`n_lines\` apply only to text files.\\n- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the \`<system>\` block, never by measuring the displayed copy. When the \`<system>\` tag reports downsampling and you need that detail, call Read again with the \`region\` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set \`full_resolution\` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.\\n- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a file or a kimi-file:// attachment reference in the current session. Text files are read as text; image and video files are sent to the model as multimodal content (requires a model with the matching vision capability). Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "run_code", "description": "Run a TypeScript/JavaScript program in an isolated subprocess and return its console output and completion value.\\n\\n- The program body runs as an async function: top-level \`await\` and \`return\` work (e.g. \`return 1 + 2\`, \`await fetch(...).then(r => r.json())\`).\\n- \`console.log\` / \`console.info\` / \`console.warn\` / \`console.error\` / \`console.debug\` output is captured in emission order.\\n- The completion value must be JSON-serializable (objects, arrays, strings, numbers, booleans, null). \`undefined\` (e.g. a bare \`return\`) reports \`value: undefined\`. Functions, classes, and circular structures fail with an \`invalid-output\` error.\\n- No state survives between calls — each run spawns a fresh subprocess.\\n- The subprocess runs under a memory cap; a program that exceeds it fails with a \`memory-limit\` error and cannot take the host down with it.\\n- The subprocess is a soft isolation boundary, NOT a security sandbox: treat model-written code with the same trust level as a Bash command.\\n- Prefer this tool over Bash for pure computation, data transformation, algorithm verification, parsing, and small scripting tasks that do not need shell features.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "code": { "type": "string", "minLength": 1, "description": "The TypeScript/JavaScript program to run. The body executes as an async function, so top-level await and return work. console.log/info/warn/error/debug output is captured." }, "timeout_ms": { "default": 30000, "description": "Execution budget in milliseconds before the worker is terminated (default 30000).", "type": "integer", "minimum": 1000, "maximum": 120000 } }, "required": [ "code" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load tools by exact name, or search for them by capability when the name is unknown. The loadable names are listed in the <tools_added>/<tools_removed> or <tools_relevant> announcements in the system context — use the latest announcement. If you have not seen a loadable-tools announcement in this session, no tools are currently loadable. Pass names to load them, or pass query to search all loadable tools; a search returns candidates only, so call select_tools again with exact names to load the ones you need. The full definitions become available immediately, so you can call them directly in your next tool call. Tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "description": "Exact tool names to load, taken from the latest announcement or a prior search result.", "minItems": 1, "type": "array", "items": { "type": "string" } }, "query": { "description": "Capability description to search for when the exact tool name is unknown; returns candidates without loading them.", "type": "string", "minLength": 1 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "session_query", "description": "Search prior session history: cross-session full-text search over your own workspace's sessions, within-session event search, and fork-lineage tracing.\\n\\nOperations:\\n- \`session_search\`: full-text search across the workspace's sessions. The \`query\` is a literal phrase; results rank sessions by the strongest matching event and include a bounded snippet. Optional filters narrow the corpus: \`session_ids\`, \`created_at_from\`/\`created_at_to\` (inclusive ISO 8601), \`parent_session_ids\`, \`include_root_sessions\`, \`availability\` (\`live\`/\`persisted\`), and event bounds \`event_seq_from\`/\`event_seq_to\`/\`event_time_from\`/\`event_time_to\`/\`event_types\`.\\n- \`event_search\`: full-text search within one session's events (omit \`session_id\` for the current session). Same query semantics; optional \`seq_from\`/\`seq_to\`/\`time_from\`/\`time_to\`/\`event_types\` bounds.\\n- \`session_trace\`: fork lineage of one session (omit \`session_id\` for the current session) — the ancestor chain and descendant trees.\\n\\nQueries are interpreted as data, never as query syntax. Results are capped at 20 entries; narrow the query or add filters to find more.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "session_search", "event_search", "session_trace" ], "description": "Which session-query operation to run: session_search (cross-session full-text search), event_search (within-session event search), or session_trace (fork lineage of one session)." }, "operationArgs": { "description": "Operation-specific arguments (validated per operation).", "type": "object", "propertyNames": { "type": "string" }, "additionalProperties": {} } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget for the current goal, only when the user clearly states one, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not set one for vague wording such as \\"spend some time\\" or \\"try to be quick\\". Convert a compound time to one unit first: \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "path": { "description": "Optional exact Path from the current skill listing, used to select a same-name variant.", "type": "string" }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SnapshotList", "description": "List the versions this session recorded for a file before it was overwritten.\\n\\nWrite and Edit keep a record of the content they replace. This tool reads that record for one path and answers who replaced it, when, and in which session or subagent: each line carries the time, the tool that wrote, the size, a short content hash, and the agent that did it. Versions come newest first; index 1 is the most recent overwrite.\\n\\nIt never returns the recorded content. To put a version back, the user runs \`kimi snapshot restore <path> --previous\` (or \`--hash <sha|id>\` for a specific one).\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "minLength": 1, "description": "File path whose recorded versions to list, as written in the tool call or absolute. The newest version comes first." } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status, including task IDs for \`TaskOutput\`.\\n\\nAfter context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With \`active_only=false\`, \`lost\` tasks from previous processes may appear; treat them as terminated.\\n\\nThis tool is read-only and safe in plan mode; it does not return task output.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a non-blocking snapshot of a running or completed background task.\\n\\nUse after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "id": { "description": "Stable identifier of the item, as returned by a previous call. Reuse it so an update lands on the same item instead of creating a new one. Omit on first write; missing ids are assigned as T1, T1.1, and so on.", "type": "string" }, "parentId": { "description": "Id of the milestone this item belongs to. Null or omitted for milestones and for a flat list.", "anyOf": [ { "type": "string" }, { "type": "null" } ] }, "kind": { "description": "Milestone groups leaf tasks; task is a leaf unit of work. Defaults to task.", "type": "string", "enum": [ "milestone", "task" ] }, "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." }, "progress": { "description": "Completion percentage 0-100 of an in_progress leaf task. Omit on milestones (computed from children) and on done items (implies 100).", "type": "number", "minimum": 0, "maximum": 100 }, "description": { "description": "Optional longer note about the item.", "type": "string" } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. \`active\` resumes a paused or blocked goal when the user explicitly asks you to work on it again. \`complete\` and \`blocked\` end autonomous work: while a goal is active, its full reminder states exactly when each one is warranted; later reminders keep the current goal state and point back to those rules. Follow them, and do not call this tool merely because you finished a slice of work. After \`complete\` or \`blocked\`, write the completion summary or the blocker explanation in your next message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WebSearch", "description": "Search the web for information. Use this when you need up-to-date information from the internet.\\n\\nEach result includes its title, its URL, and a snippet, plus its source site and publication date when available. Results are short summaries, not full pages — when a result looks relevant, call the FetchURL tool on its URL to read the full page content. Fetch only the few URLs you actually need. Prefer specific queries, and refine the query if the results don't contain what you need.\\n\\nWhen you rely on a result in your answer, cite its source URL so the user can verify it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "query": { "type": "string", "description": "The query text to search for." } }, "required": [ "query" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Workflow", "description": "Run multi-phase orchestrated agent workflows.\\n\\n## Operations\\n\\n### \`run\` — start a workflow\\nLaunches a workflow in the background. Returns immediately with a \`run_id\`; the result is delivered as a notification when the workflow completes.\\n\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"How does RAG compare to fine-tuning?\\" })\\n\`\`\`\\n\\nYou can also run an inline script:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", script: \\"export const meta = { name: 'quick', description: '...' };\\\\nphase('search');\\\\nconst result = await agent('Search for...');\\\\nreturn result;\\", args: \\"...\\" })\\n\`\`\`\\n\\nThe script runs under a 30-minute default deadline, counted from launch and covering the whole script, not just its synchronous start. Pass \`deadline_ms\` to raise or lower it for a single run — a long workflow that intentionally runs for hours must ask for the time it needs:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"...\\", deadline_ms: 7200000 })\\n\`\`\`\\nA script that exceeds the deadline is aborted: the run ends as \`failed\` with \`Workflow script deadline exceeded\`, and any subagent it started is cancelled. The same applies to a script stuck in a tight synchronous loop with no \`await\`: that kind of loop blocks the process it runs in, so it is cut off at 30 seconds and the run fails.\\n\\n### \`status\` — check progress\\n\`\`\`\\nWorkflow({ operation: \\"status\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n### \`wait\` — block until done\\n\`\`\`\\nWorkflow({ operation: \\"wait\\", run_id: \\"wf_1\\", timeout_ms: 60000 })\\n\`\`\`\\n\\n### \`cancel\` — cancel a running workflow\\n\`\`\`\\nWorkflow({ operation: \\"cancel\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n## Built-in workflows\\n\\n- **deep-research** — Multi-source research with adversarial jury fact-checking. Plans search lines, runs parallel web searches, extracts facts from top sources, cross-checks each fact with 3 jurors (majority reject drops it), and writes a cited report.\\n- **code-review** — Multi-dimensional code review across security, performance, correctness, and maintainability. Runs parallel reviewers and produces a consolidated severity-ranked report.\\n- **test-generator** — Automated test generation. Analyzes source code, plans test cases, generates test files with proper mocks, and validates output.\\n- **refactor-planner** — Refactoring impact analysis and migration planner. Identifies improvement opportunities, assesses risk, and generates a phased plan with rollback steps.\\n- **bug-triage** — Automated bug triage. Parses error logs and stack traces, reads suspect source files, identifies root causes, and generates fixes with reproduction steps.\\n- **pr-description** — PR description generator. Analyzes code diffs, extracts semantic intent, and generates a comprehensive PR body with changelog entries and reviewer guidance.\\n- **architecture-review** — Architecture and dependency analysis. Detects circular dependencies, measures coupling, identifies layer violations, and generates architecture documentation.\\n- **security-audit** — Security vulnerability audit. Scans for OWASP Top 10, hardcoded secrets, injection points, auth flaws, and produces a prioritized remediation plan.\\n- **migration-planner** — Migration and upgrade planner. Analyzes dependency versions, identifies breaking changes, maps code changes, and generates a phased migration plan with compatibility shims.\\n\\n## In-script primitives\\n\\nWorkflow scripts are JavaScript that runs in a sandbox with these injected globals:\\n\\n- **\`agent(prompt, opts?)\`** — Spawn a subagent. Returns the agent's result (parsed JSON if \`opts.schema\` given, else text) or \`null\` on failure. **Never throws.**\\n  - \`opts.agentType\` — subagent profile (default 'coder')\\n  - \`opts.schema\` — JSON schema for structured output\\n  - \`opts.label\` — display label\\n\\n- **\`parallel(thunks)\`** — Run thunks concurrently. Returns array of results.\\n\\n- **\`pipeline(items, ...stages)\`** — Run each item through all stages. No barrier between stages — items flow through independently.\\n\\n- **\`phase(title)\`** — Set the current phase (for progress tracking).\\n\\n- **\`log(message)\`** — Log a message.\\n\\n- **\`readFile(path)\` / \`writeFile(path, content)\` / \`glob(pattern)\` / \`exists(path)\`** — File IO jailed to the workspace root.\\n\\n- **\`args\`** — The \`args\` value passed to \`run\`.\\n\\n- **\`fetch(url, opts?)\`** — Make an HTTP request. Returns \`{ ok, status, body }\`. \`opts\` can have \`method\`, \`headers\`, \`body\`. 15s timeout. Never throws — failures return \`{ ok: false, status: 0, body: errorMessage }\`.\\n\\n- **\`search(query)\`** — Web search. Returns an array of \`{ title, url, snippet }\`. Returns empty array when search is unavailable or fails. Never throws.\\n\\n- **\`exec(command, opts?)\`** — Execute a shell command. Returns \`{ stdout, stderr, exitCode }\`. \`opts\` can have \`timeoutMs\` (default 30s) and \`cwd\` (relative to workspace root). The command runs in the workspace directory. Never throws — non-zero exit codes are returned, not thrown.\\n\\n## When to use\\n\\n- **Deep research** — when the user wants a thorough, multi-source, fact-checked answer\\n- **Code review** — when the user wants a multi-dimensional review of code changes\\n- **Test generation** — when the user wants to add tests for existing untested code\\n- **Refactoring** — when the user wants to plan safe, incremental code improvements\\n- **Bug triage** — when the user reports an error, crash, or test failure\\n- **PR descriptions** — when the user needs to document code changes for a pull request\\n- **Architecture review** — when evaluating system design or detecting design decay\\n- **Security audit** — when auditing code for OWASP Top 10 vulnerabilities\\n- **Migration planning** — when upgrading dependencies or migrating between frameworks\\n- **Complex orchestration** — when a task requires multiple phases of parallel agent work\\n- **Structured pipelines** — when you need to chain agent outputs through transformation stages\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "run", "status", "wait", "cancel" ], "description": "The workflow operation to perform." }, "name": { "description": "Built-in or user workflow name (for \`run\`). Mutually exclusive with \`script\`.", "type": "string" }, "script": { "description": "Inline workflow script (for \`run\`). Mutually exclusive with \`name\`.", "type": "string" }, "args": { "description": "Arguments to pass to the workflow (for \`run\`).", "type": "string" }, "run_id": { "description": "Workflow run ID (for \`status\`, \`wait\`, \`cancel\`).", "type": "string" }, "timeout_ms": { "description": "Timeout in milliseconds (for \`wait\`).", "type": "number" }, "deadline_ms": { "description": "Total runtime limit in milliseconds for the script (for \`run\`). Defaults to 1800000 (30 minutes).", "type": "number" } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Use Write only for new files, complete replacements, or content with little continuity.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } } ] }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } }, "time": "<time>" }
      [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [], "time": "<time>" }
      [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] thinking.delta              { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "<think-1>" }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "<text-1>" }
      [emit] thinking.delta              { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "" }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "<text-2>" }
      [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "agentId": "main", "length": 3, "tokens": 13, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 13 }
      [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 1, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 3, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 10 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "think", "think": "<think-1>" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "<text-1><text-2>" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "think", "think": "<think-1>" }, { "type": "text", "text": "<text-1><text-2>" } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 3, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
      [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }"
    `);
    expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
    "system: <system-prompt>
    tools: []
    messages:
      user: text "Hello""
  `);
  });

  it('persists a turn.ended wire record with the end reason and duration', async () => {
    profile.update({ activeToolNames: [] });

    ctx.mockNextResponse({ type: 'text', text: 'done' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    const record = (await ctx.persistedWireRecords()).find((entry) => entry.type === 'turn.ended');
    expect(record).toMatchObject({ turnId: 0, reason: 'completed' });
    expect(record?.['durationMs']).toEqual(expect.any(Number));
    expect(record?.['time']).toEqual(expect.any(Number));
  });

  it('restores the engine turn clock from the machine journal on resume', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();

    const records = await ctx.persistedWireRecords();
    expect(records.some((record) => record.type === 'agent.turn.ended')).toBe(true);

    const resumed = createTestAgent(
      wireRecordPersistenceServices(new InMemoryWireRecordPersistence(records)),
    );
    try {
      await resumed.restorePersisted();
      const turnIds: number[] = [];
      const subscription = resumed
        .get(IEventBus)
        .subscribe(TurnStarted, (event) => turnIds.push(event.turnId));
      resumed.mockNextResponse({ type: 'text', text: 'second answer' });
      await resumed.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
      await resumed.untilTurnEnd();
      subscription.dispose();

      expect(turnIds).toEqual([1]);
      const persisted = await resumed.persistedWireRecords();
      expect(
        persisted
          .filter((record) => record.type === 'agent.turn.ended')
          .map((record) => record['turnId']),
      ).toEqual([0, 1]);
    } finally {
      await resumed.dispose();
    }
  });

  it('fails the turn after a filtered step completes', async () => {
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'blocked' }],
      finishReason: 'filtered',
    });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });

    expect(renderSnapshot(await ctx.untilTurnEnd())).toMatchInlineSnapshot(`
      "[emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Hello" } ], "createdAt": "<time>" }
      [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
      [emit] turn.prompt                 { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Hello" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
      [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Hello" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] agent.message.appended      { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Hello" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.started          { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
      [wire] tool_select.initialized     { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task in its own context.\\n\\nDo not launch a subagent unless the user explicitly asks for one, including delegation, parallel agents, or a named agent type. Explicit instructions in AGENTS.md or a skill, and user-enabled multi-agent modes, also authorize launching. Large or multi-part tasks and requests for depth, thoroughness, research, or investigation do not; do that work yourself. Agent type descriptions below guide selection only after authorization. Resuming already-authorized work needs no new request. Each subagent starts cold and re-derives context, costing time and tokens.\\n\\nWriting the prompt:\\n- Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups: put exact paths or commands you already know in the prompt.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nWith \`run_in_background=true\`, the subagent runs detached and its result arrives automatically in a later turn as a synthetic user-role message — for an agent task it states that the subagent finished and points at the output file, so read that file to get the result. Continue with other work or respond to the user, and never fabricate or predict the result. Use it only when you have other work to do meanwhile. When your next step needs the result, run the subagent in the foreground instead of launching it in the background and waiting on it.\\n\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, WebSearch, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, ExitSpecMode, Glob, Grep, Read, run_code, Skill, SnapshotList, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out. Pass a flat object: keys are existing \`agent_id\` strings (as reported in a previous swarm's \`<subagent agent_id=\\"...\\">\` output), values are the continuation prompt for that subagent (usually \`\\"continue\\"\` if no extra information is needed). For example, with \`resume_agent_ids\` set to \`{\\"agent-coder-1\\": \\"continue\\", \\"agent-coder-2\\": \\"focus on the imports\\"}\`, AgentSwarm resumes those two existing subagents and spawns no new ones. You may combine \`resume_agent_ids\` with \`items\` to resume some and spawn others; resumed agents always run before fresh spawns and keep their original \`subagent_type\` and model. \`resume_agent_ids\` is a flat record — do not pass an array or a list of \`{item, prompt}\` objects, and do not use \`{{item}}\` as a key: that placeholder only applies to \`prompt_template\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Flat object: keys are existing subagent agent_id strings (from a previous swarm's \`<subagent agent_id=\\"...\\">\` result), values are the continuation prompt for that subagent (e.g. \\"continue\\"). Resumed subagents run before new item-based subagents. Do not pass an array or a list of {item, prompt} objects.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- Group related questions into one call to minimize interruptions\\n- List a recommended option first\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "description": "Whether the user can select multiple options.", "type": "boolean" }, "multiSelect": { "description": "Deprecated camelCase alias of multi_select; prefer multi_select.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, and anything the dedicated tools do not cover.\\n\\n- \`ls\` / \`find\` (list files) → \`Glob\`\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nEach call runs in a fresh shell: variables and \`cd\` do not persist, so pass \`cwd\` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with \`Command failed with exit code: N\`. Do not run interactive commands or commands that never exit. Set \`timeout\` for possibly long-running commands. A foreground command that hits its timeout is moved to the background instead of being killed, and you are notified when it completes. The user can also move a running foreground command to the background at any time.\\n\\nFor long-running builds, tests, watchers, or servers that the conversation should not wait on, set \`run_in_background=true\` with a short \`description\`; the call returns a task ID. Set \`disable_timeout=true\` only when the task should run without a timeout. You are notified automatically when the task completes, so return control to the user instead of waiting on it. Use \`TaskOutput\` only for a non-blocking snapshot, and \`TaskStop\` only to cancel.\\n\\n- Use \`&&\` for commands that depend on each other. Issue independent read-only commands (separate \`git show\`, \`ls\`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with \`echo\` separators.\\n- Avoid \`..\` paths outside the working directory, and do not modify files outside it unless explicitly instructed.\\n- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n- Command availability depends on the host; run \`which <command>\` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the \`gh\` CLI when installed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable goal that the runtime pursues across multiple turns. Call it only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one. Do not create a goal for greetings, ordinary questions, or requests without a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion first; if they clearly insist after you warn them that the wording is vague or risky, create the goal anyway. Include \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise and reference long task descriptions by file path. Creating fails if a goal already exists; pass \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued later in this session, recurring or once.\\n\\nWhen the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: \\"around 9\\" → \`57 8 * * *\`, \\"hourly\\" → \`7 * * * *\`.\\n\\nTasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with \`coalescedCount\` > 1: act on the latest state once. The final fire carries \`stale=\\"true\\"\`, so call CronCreate again with the same \`cron\` and \`prompt\` if the schedule is still wanted.\\n\\nUsers cannot manage cron tasks themselves: after creating one, tell the user its \`id\` and that they can ask you to cancel or change it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a live cron task by its \`id\`. Fired one-shots and expired tasks are already gone; if an id is not found, call CronList instead of retrying it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List this session's cron tasks. Read-only. \`stale: true\` marks a recurring task whose next fire is its last. After a context compaction, call this instead of guessing ids.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "EnterSpecMode", "description": "Use this tool when the user asks for a spec, or when a change is large enough that agreeing on the contract before writing code is worth a detour.\\n\\nGetting sign-off on a written spec before implementation prevents wasted effort: the user reviews requirements, design and tasks once, then you execute against that agreed contract instead of guessing.\\n\\n**What spec mode is for.** Plan mode produces a throwaway plan for one session. Spec mode writes documents that live in the repository, get committed alongside the code, and are read again by later sessions and teammates. Reach for it when the artifact should outlive this conversation.\\n\\n**Your workflow — write all four before calling ExitSpecMode:**\\n\\n1. Investigate with read-only tools (Read, Grep, Glob). Use Bash only when needed.\\n2. Write \`requirements.md\` — what to build. State the goal, who it is for, the boundaries, and explicitly what is *out of scope*. A requirement the user did not imply is a defect, not initiative.\\n3. Write \`design.md\` — how to build it. Name the concrete approach (files, functions, contracts), the technical constraints, and the trade-offs you rejected along with why.\\n4. Write \`tasks.md\` — how to verify it. Split the work into tasks small enough to finish and to check independently.\\n5. Call ExitSpecMode for approval. Nothing outside the spec directory can be written until the user approves.\\n\\n**Tasks must carry acceptance criteria.** A task that says \\"implement the export endpoint\\" cannot be verified. Write what must hold when it is done — the specific error, status, field, threshold or boundary that proves it. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is. Prefer criteria you can check by running something over criteria that need judgement.\\n\\n**Do not restate the project's global rules.** Conventions that already live in AGENTS.md / DEVELOP.md apply everywhere and belong there, not in a spec about one change. Reference them; do not copy them. A spec that repeats global rules goes stale the moment those rules move.\\n\\n**Keep the user in the loop on genuinely open questions.** If the requirements leave a decision that materially changes the design, ask before writing — an invented requirement buried in a spec is harder to notice than a question.\\n\\n**Constraints:**\\n- Writes are restricted to the spec directory until the user approves the spec; other edits are rejected. Call ExitSpecMode when the documents are ready.\\n- Do not create \`progress.md\` while in spec mode — it records implementation progress later, and this mode produces the three required documents above. Writes are not limited to those three: any file inside the spec directory is writable, so \`progress.md\` is accepted if the spec or the user calls for it.\\n- Plan, spec, swarm and tower modes are mutually exclusive. Entering spec mode leaves whichever of the others was active; the result names it, if any. You do not need to exit the other mode yourself.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.\\n\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitSpecMode", "description": "Use this tool when you are in spec mode and have finished writing the spec documents, and are ready for the user to review them.\\n\\n## How This Tool Works\\n- The requirements, design and tasks documents are read from the spec directory, not passed as parameters.\\n- The user sees all three when they review. In auto permission mode the tool exits spec mode without asking.\\n- All three must be non-empty. A missing or empty document is rejected, naming the file you still have to write.\\n\\n## When to Use\\nUse it only when the spec is genuinely ready to be approved. It does not verify the quality of what you wrote — it checks that the three documents exist and hands them to the user.\\n\\n## What a good spec contains\\n- **Requirements**: the goal, who it is for, the boundaries, and what is explicitly out of scope. A requirement the user did not imply is a defect.\\n- **Design**: the concrete approach — real files, functions and contracts — plus the trade-offs you rejected and why.\\n- **Tasks**: work split small enough to finish and to check, each with acceptance criteria. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is.\\n\\n## Multiple Approaches\\nIf the design document leaves a genuine choice between approaches, pass them via the \`options\` parameter so the user can pick which one to execute. Each option must correspond to an approach the design document actually describes.\\n\\n## After Approval\\nSpec mode ends and normal tool permissions return. Work through the tasks document, and record progress in the spec's progress file as you go. The progress file is a working note for whoever reads the spec next; it is not gated by this tool.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the design document leaves a genuine choice between approaches, list them here so the user can pick which one to execute. Provide up to 3 options; 2-3 distinct approaches work best. Each option must correspond to an approach the design document actually describes. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, budgets with what remains of each, and the terminal reason once it has stopped. Returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — recursive from the search root; \`src/*.ts\` — only directly inside \`src/\`\\n- \`src/**/*.ts\` — recursive beneath \`src/\`\\n- \`*.{ts,tsx}\` and \`{src,test}/**/*.ts\` — brace expansion\\n\\nFollow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.\\n\\nAvoid broad searches in dependency or build-output directories, especially with \`include_ignored\`; prefer a narrow \`path\` or \`pattern\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files are searched by default.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Knowledge", "description": "Use this tool to interact with the local knowledge base — a structured store of coding standards, pitfalls, architecture decisions, and workflow rules for the current project.\\n\\nThe knowledge base is automatically queried before each turn to inject relevant standards. You can also actively search, add, confirm, or reject entries.\\n\\nSub-commands (pass as the \`action\` parameter):\\n- \`search\`: Find entries relevant to a query, file path, or tags\\n- \`add\`: Record a new standard or pitfall discovered during work\\n- \`confirm\`: Upgrade an AI-learned entry to confirmed (confidence → 1.0)\\n- \`reject\`: Remove an incorrect or outdated entry\\n\\nWhen to use:\\n- After discovering a non-obvious constraint or convention: use \`add\`\\n- When the user corrects you and the correction is a reusable rule: use \`add\`\\n- When reviewing existing entries: use \`search\`\\n- To validate or dismiss auto-learned entries: use \`confirm\` or \`reject\`\\n\\nDo NOT use this tool for:\\n- General knowledge or facts (only project-specific standards)\\n- Temporary per-session preferences\\n- Information already in AGENTS.md (avoid duplication)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "add", "confirm", "reject" ] }, "query": { "type": "string" }, "scope": { "type": "string" }, "tags": { "type": "string" }, "id": { "type": "string" }, "title": { "type": "string" }, "category": { "type": "string", "enum": [ "coding-style", "pitfall", "architecture", "workflow" ] }, "content": { "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Memory", "description": "Search and manage persistent memory across sessions.\\n\\nMemory files are markdown documents stored under \`~/.kimi-code/memory/\`, organized by scope:\\n- **global** — cross-project knowledge (architecture decisions, coding standards, tool configs)\\n- **project** — project-specific knowledge tied to the current working directory\\n- **session** — session-specific notes and context\\n\\n## Actions\\n\\n### \`search\`\\nFull-text search over all memory entries. Returns matching snippets with scope and relevance score. Requires \`query\`.\\n\`\`\`\\nMemory({ action: \\"search\\", query: \\"authentication pattern\\" })\\n\`\`\`\\n\\n### \`read\`\\nRead a specific memory file by its relative path.\\n\`\`\`\\nMemory({ action: \\"read\\", path: \\"global/auth-pattern.md\\" })\\n\`\`\`\\n\\n### \`write\`\\nCreate or update a memory file. The \`scope\` determines where it lives:\\n- \`global\` — stored at \`~/.kimi-code/memory/global/\`\\n- \`project\` — stored at \`~/.kimi-code/memory/projects/<projectId>/\`\\n- \`session\` — stored at \`~/.kimi-code/memory/sessions/<sessionId>/\`\\n\\n\`\`\`\\nMemory({\\n  action: \\"write\\",\\n  scope: \\"project\\",\\n  path: \\"auth-pattern\\",\\n  content: \\"# Authentication Pattern\\\\n\\\\nUse JWT with refresh tokens...\\"\\n})\\n\`\`\`\\n\\n### \`list\`\\nList all memory files, optionally filtered by scope.\\n\`\`\`\\nMemory({ action: \\"list\\", scope: \\"global\\" })\\n\`\`\`\\n\\n### \`delete\`\\nDelete a memory file by its relative path.\\n\`\`\`\\nMemory({ action: \\"delete\\", path: \\"global/old-note.md\\" })\\n\`\`\`\\n\\n### \`log\`\\nList the memory repository's recent commits, newest first, each with its short\\nsha, date and message. Use it to pick a revision before \`revert\`.\\n\`\`\`\\nMemory({ action: \\"log\\" })\\n\`\`\`\\n\\n### \`revert\`\\nRoll one memory commit back. Takes the full \`sha\` reported by \`log\`; a short sha\\nis rejected. The search index is resynchronised from disk before the call\\nreturns, so a reverted file stops matching immediately.\\n\`\`\`\\nMemory({ action: \\"revert\\", sha: \\"<full sha>\\" })\\n\`\`\`\\n\\n## Scope semantics\\n\\n- \`search\` covers **every** project and session unless \`scope\` is given; pass\\n  \`scope\` to restrict it to the current project, the global scope, or this\\n  session.\\n- \`write\` defaults to \`project\` and never writes outside the scope you name.\\n- \`list\` defaults to everything; with \`scope\` it returns only that scope of the\\n  current project or session.\\n\\n\`project\` scope is keyed by the repository when there is one: the identity comes\\nfrom the \`origin\` remote first, then from the repository root, and only falls\\nback to the working directory path outside git. A repository with an \`origin\`\\nremote keeps the same project bucket after re-cloning, renaming or moving; a\\nrepository without one keeps it when you work from any directory inside it.\\n\\n## Git memory interaction\\n\\nWhen the \`git_memory\` experiment is enabled, \`write\` additionally requires the\\ncontent to cite a real commit: a 7–40 character hex string that \`git cat-file\`\\nresolves in the session working directory or in the memory repository. A write\\nwithout one is rejected. With the experiment on, every write and delete is\\ncommitted to that repository (\`remember:\`, \`update:\`, \`forget:\`), which is what\\n\`log\` lists and \`revert\` rolls back. With the experiment off, no such\\nrequirement applies and nothing is committed.\\n\\n## When to use\\n\\n- **Before starting a task** — search memory for relevant context from past sessions\\n- **After learning something important** — write it to memory for future reference\\n- **When you encounter a pattern or decision** — persist it so future you doesn't rediscover it\\n- **When debugging** — search for similar past issues and their resolutions\\n\\nMemory persists across sessions and projects. Use it to build up institutional knowledge.\\n\\nThe search index is rebuilt from the files on disk at most once every ten minutes, so\\na file edited outside this tool shows up in \`search\` and \`list\` within that window\\nrather than immediately.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "read", "write", "list", "delete", "log", "revert" ], "description": "The memory operation to perform. Required." }, "query": { "description": "Search query (for \`search\` action).", "type": "string" }, "path": { "description": "Memory file path (for \`read\`, \`write\`, \`delete\`). Can include or omit \`.md\` extension. For \`read\`/\`delete\`, this is the full relative path (e.g. \`global/auth.md\`). For \`write\`, this is the filename within the chosen scope.", "type": "string" }, "scope": { "description": "Memory scope (for \`search\`, \`write\`, \`list\`). \`search\` defaults to every scope of every project; \`write\` defaults to \`project\`; \`list\` defaults to all scopes.", "type": "string", "enum": [ "global", "project", "session" ] }, "content": { "description": "Markdown content (for \`write\` action).", "type": "string" }, "sha": { "description": "Memory repository commit sha (for \`revert\` action).", "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "PowerShell", "description": "Execute a Windows PowerShell script natively (PowerShell 7 \`pwsh\` when available, otherwise Windows PowerShell 5.1). The script runs as a direct PowerShell process — it is not routed through bash.\\n\\n**When to use this instead of Bash:**\\n\\n- The task is inherently PowerShell: Windows registry, services, scheduled tasks, winget, WinGet/MSI installs, COM/WinRM, Windows event logs, NTFS ACLs, certificate store.\\n- You need PowerShell cmdlets or .NET types (\`Get-Service\`, \`Get-ItemProperty\`, \`[System.*]\`).\\n- You are on Windows and about to run \`powershell.exe\` / \`pwsh\` from the Bash tool — do not: the bash→native-PowerShell bridge re-encodes output and corrupts non-ASCII text. Use this tool instead; output is always decoded as UTF-8.\\n\\n**When to keep using Bash:** anything with POSIX shell semantics — pipes over coreutils, git, package managers of the project, build/test runners. File reads/edits/searches belong to \`Read\` / \`Edit\` / \`Glob\` / \`Grep\` regardless of platform.\\n\\n**Behavior:**\\n\\n- The script is passed as a single \`-EncodedCommand\` payload, so quoting and encoding are handled for you; write ordinary PowerShell script text. Interactive input is not supported.\\n- The session runs with \`-NoProfile -NonInteractive\`. Output encoding is pinned to UTF-8, so non-ASCII text (including Chinese) comes back clean.\\n- stdout and stderr are combined and returned as a string. The output may be truncated if it is too long. A non-zero exit ends the result with a \`Command failed with exit code: N\` line; a script killed by its timeout or interrupted by the user ends with its own message instead.\\n- Each call runs in a fresh process: variables and location do not persist between calls. To run in a particular directory, pass the \`cwd\` argument.\\n- Foreground calls default to 60s and allow up to 300s; a foreground call that hits its timeout is moved to the background instead of being killed.\\n\\nIf \`run_in_background=true\`, the script will be started as a background task and this tool will return a task ID instead of waiting for completion. When doing that, you must provide a short \`description\`. Background commands default to 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not wait on a task you just launched. Use \`TaskStop\` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the background-task panel.\\n\\n**Safety:** do not use this tool to escape the working directory, to modify files outside of it unless instructed, or to run commands that require superuser privileges unless explicitly instructed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The PowerShell script to execute." }, "cwd": { "description": "The working directory in which to run the script. When omitted, the script runs in the session's working directory.", "type": "string" }, "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991, "description": "Optional timeout in seconds for the script to execute." }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the script as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the script. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Read", "description": "Read a text file from the active environment's filesystem. Do not fully trust comments and documentation.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Output is \`<line-number>\\\\t<content>\` per line. A \`<system>\` status block may follow; it is not part of the file.\\n- Results are bounded by \`max_chars\`: 100000 by default, up to 500000, and by about 500000 divided by four estimated tokens.\\n- If the status block reports an incomplete range, continue with its \`Next Read\` arguments exactly. Do not answer from a partial page when the task requires the remaining content.\\n- **Images and videos** (max 100MB) are sent to the model as multimodal media instead of text; this requires a model with the matching vision capability (\`image_in\` / \`video_in\`). \`region\` and \`full_resolution\` apply only to images; \`line_offset\` and \`n_lines\` apply only to text files.\\n- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the \`<system>\` block, never by measuring the displayed copy. When the \`<system>\` tag reports downsampling and you need that detail, call Read again with the \`region\` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set \`full_resolution\` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.\\n- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a file or a kimi-file:// attachment reference in the current session. Text files are read as text; image and video files are sent to the model as multimodal content (requires a model with the matching vision capability). Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "run_code", "description": "Run a TypeScript/JavaScript program in an isolated subprocess and return its console output and completion value.\\n\\n- The program body runs as an async function: top-level \`await\` and \`return\` work (e.g. \`return 1 + 2\`, \`await fetch(...).then(r => r.json())\`).\\n- \`console.log\` / \`console.info\` / \`console.warn\` / \`console.error\` / \`console.debug\` output is captured in emission order.\\n- The completion value must be JSON-serializable (objects, arrays, strings, numbers, booleans, null). \`undefined\` (e.g. a bare \`return\`) reports \`value: undefined\`. Functions, classes, and circular structures fail with an \`invalid-output\` error.\\n- No state survives between calls — each run spawns a fresh subprocess.\\n- The subprocess runs under a memory cap; a program that exceeds it fails with a \`memory-limit\` error and cannot take the host down with it.\\n- The subprocess is a soft isolation boundary, NOT a security sandbox: treat model-written code with the same trust level as a Bash command.\\n- Prefer this tool over Bash for pure computation, data transformation, algorithm verification, parsing, and small scripting tasks that do not need shell features.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "code": { "type": "string", "minLength": 1, "description": "The TypeScript/JavaScript program to run. The body executes as an async function, so top-level await and return work. console.log/info/warn/error/debug output is captured." }, "timeout_ms": { "default": 30000, "description": "Execution budget in milliseconds before the worker is terminated (default 30000).", "type": "integer", "minimum": 1000, "maximum": 120000 } }, "required": [ "code" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load tools by exact name, or search for them by capability when the name is unknown. The loadable names are listed in the <tools_added>/<tools_removed> or <tools_relevant> announcements in the system context — use the latest announcement. If you have not seen a loadable-tools announcement in this session, no tools are currently loadable. Pass names to load them, or pass query to search all loadable tools; a search returns candidates only, so call select_tools again with exact names to load the ones you need. The full definitions become available immediately, so you can call them directly in your next tool call. Tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "description": "Exact tool names to load, taken from the latest announcement or a prior search result.", "minItems": 1, "type": "array", "items": { "type": "string" } }, "query": { "description": "Capability description to search for when the exact tool name is unknown; returns candidates without loading them.", "type": "string", "minLength": 1 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "session_query", "description": "Search prior session history: cross-session full-text search over your own workspace's sessions, within-session event search, and fork-lineage tracing.\\n\\nOperations:\\n- \`session_search\`: full-text search across the workspace's sessions. The \`query\` is a literal phrase; results rank sessions by the strongest matching event and include a bounded snippet. Optional filters narrow the corpus: \`session_ids\`, \`created_at_from\`/\`created_at_to\` (inclusive ISO 8601), \`parent_session_ids\`, \`include_root_sessions\`, \`availability\` (\`live\`/\`persisted\`), and event bounds \`event_seq_from\`/\`event_seq_to\`/\`event_time_from\`/\`event_time_to\`/\`event_types\`.\\n- \`event_search\`: full-text search within one session's events (omit \`session_id\` for the current session). Same query semantics; optional \`seq_from\`/\`seq_to\`/\`time_from\`/\`time_to\`/\`event_types\` bounds.\\n- \`session_trace\`: fork lineage of one session (omit \`session_id\` for the current session) — the ancestor chain and descendant trees.\\n\\nQueries are interpreted as data, never as query syntax. Results are capped at 20 entries; narrow the query or add filters to find more.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "session_search", "event_search", "session_trace" ], "description": "Which session-query operation to run: session_search (cross-session full-text search), event_search (within-session event search), or session_trace (fork lineage of one session)." }, "operationArgs": { "description": "Operation-specific arguments (validated per operation).", "type": "object", "propertyNames": { "type": "string" }, "additionalProperties": {} } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget for the current goal, only when the user clearly states one, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not set one for vague wording such as \\"spend some time\\" or \\"try to be quick\\". Convert a compound time to one unit first: \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "path": { "description": "Optional exact Path from the current skill listing, used to select a same-name variant.", "type": "string" }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SnapshotList", "description": "List the versions this session recorded for a file before it was overwritten.\\n\\nWrite and Edit keep a record of the content they replace. This tool reads that record for one path and answers who replaced it, when, and in which session or subagent: each line carries the time, the tool that wrote, the size, a short content hash, and the agent that did it. Versions come newest first; index 1 is the most recent overwrite.\\n\\nIt never returns the recorded content. To put a version back, the user runs \`kimi snapshot restore <path> --previous\` (or \`--hash <sha|id>\` for a specific one).\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "minLength": 1, "description": "File path whose recorded versions to list, as written in the tool call or absolute. The newest version comes first." } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status, including task IDs for \`TaskOutput\`.\\n\\nAfter context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With \`active_only=false\`, \`lost\` tasks from previous processes may appear; treat them as terminated.\\n\\nThis tool is read-only and safe in plan mode; it does not return task output.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a non-blocking snapshot of a running or completed background task.\\n\\nUse after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "id": { "description": "Stable identifier of the item, as returned by a previous call. Reuse it so an update lands on the same item instead of creating a new one. Omit on first write; missing ids are assigned as T1, T1.1, and so on.", "type": "string" }, "parentId": { "description": "Id of the milestone this item belongs to. Null or omitted for milestones and for a flat list.", "anyOf": [ { "type": "string" }, { "type": "null" } ] }, "kind": { "description": "Milestone groups leaf tasks; task is a leaf unit of work. Defaults to task.", "type": "string", "enum": [ "milestone", "task" ] }, "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." }, "progress": { "description": "Completion percentage 0-100 of an in_progress leaf task. Omit on milestones (computed from children) and on done items (implies 100).", "type": "number", "minimum": 0, "maximum": 100 }, "description": { "description": "Optional longer note about the item.", "type": "string" } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. \`active\` resumes a paused or blocked goal when the user explicitly asks you to work on it again. \`complete\` and \`blocked\` end autonomous work: while a goal is active, its full reminder states exactly when each one is warranted; later reminders keep the current goal state and point back to those rules. Follow them, and do not call this tool merely because you finished a slice of work. After \`complete\` or \`blocked\`, write the completion summary or the blocker explanation in your next message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WebSearch", "description": "Search the web for information. Use this when you need up-to-date information from the internet.\\n\\nEach result includes its title, its URL, and a snippet, plus its source site and publication date when available. Results are short summaries, not full pages — when a result looks relevant, call the FetchURL tool on its URL to read the full page content. Fetch only the few URLs you actually need. Prefer specific queries, and refine the query if the results don't contain what you need.\\n\\nWhen you rely on a result in your answer, cite its source URL so the user can verify it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "query": { "type": "string", "description": "The query text to search for." } }, "required": [ "query" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Workflow", "description": "Run multi-phase orchestrated agent workflows.\\n\\n## Operations\\n\\n### \`run\` — start a workflow\\nLaunches a workflow in the background. Returns immediately with a \`run_id\`; the result is delivered as a notification when the workflow completes.\\n\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"How does RAG compare to fine-tuning?\\" })\\n\`\`\`\\n\\nYou can also run an inline script:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", script: \\"export const meta = { name: 'quick', description: '...' };\\\\nphase('search');\\\\nconst result = await agent('Search for...');\\\\nreturn result;\\", args: \\"...\\" })\\n\`\`\`\\n\\nThe script runs under a 30-minute default deadline, counted from launch and covering the whole script, not just its synchronous start. Pass \`deadline_ms\` to raise or lower it for a single run — a long workflow that intentionally runs for hours must ask for the time it needs:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"...\\", deadline_ms: 7200000 })\\n\`\`\`\\nA script that exceeds the deadline is aborted: the run ends as \`failed\` with \`Workflow script deadline exceeded\`, and any subagent it started is cancelled. The same applies to a script stuck in a tight synchronous loop with no \`await\`: that kind of loop blocks the process it runs in, so it is cut off at 30 seconds and the run fails.\\n\\n### \`status\` — check progress\\n\`\`\`\\nWorkflow({ operation: \\"status\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n### \`wait\` — block until done\\n\`\`\`\\nWorkflow({ operation: \\"wait\\", run_id: \\"wf_1\\", timeout_ms: 60000 })\\n\`\`\`\\n\\n### \`cancel\` — cancel a running workflow\\n\`\`\`\\nWorkflow({ operation: \\"cancel\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n## Built-in workflows\\n\\n- **deep-research** — Multi-source research with adversarial jury fact-checking. Plans search lines, runs parallel web searches, extracts facts from top sources, cross-checks each fact with 3 jurors (majority reject drops it), and writes a cited report.\\n- **code-review** — Multi-dimensional code review across security, performance, correctness, and maintainability. Runs parallel reviewers and produces a consolidated severity-ranked report.\\n- **test-generator** — Automated test generation. Analyzes source code, plans test cases, generates test files with proper mocks, and validates output.\\n- **refactor-planner** — Refactoring impact analysis and migration planner. Identifies improvement opportunities, assesses risk, and generates a phased plan with rollback steps.\\n- **bug-triage** — Automated bug triage. Parses error logs and stack traces, reads suspect source files, identifies root causes, and generates fixes with reproduction steps.\\n- **pr-description** — PR description generator. Analyzes code diffs, extracts semantic intent, and generates a comprehensive PR body with changelog entries and reviewer guidance.\\n- **architecture-review** — Architecture and dependency analysis. Detects circular dependencies, measures coupling, identifies layer violations, and generates architecture documentation.\\n- **security-audit** — Security vulnerability audit. Scans for OWASP Top 10, hardcoded secrets, injection points, auth flaws, and produces a prioritized remediation plan.\\n- **migration-planner** — Migration and upgrade planner. Analyzes dependency versions, identifies breaking changes, maps code changes, and generates a phased migration plan with compatibility shims.\\n\\n## In-script primitives\\n\\nWorkflow scripts are JavaScript that runs in a sandbox with these injected globals:\\n\\n- **\`agent(prompt, opts?)\`** — Spawn a subagent. Returns the agent's result (parsed JSON if \`opts.schema\` given, else text) or \`null\` on failure. **Never throws.**\\n  - \`opts.agentType\` — subagent profile (default 'coder')\\n  - \`opts.schema\` — JSON schema for structured output\\n  - \`opts.label\` — display label\\n\\n- **\`parallel(thunks)\`** — Run thunks concurrently. Returns array of results.\\n\\n- **\`pipeline(items, ...stages)\`** — Run each item through all stages. No barrier between stages — items flow through independently.\\n\\n- **\`phase(title)\`** — Set the current phase (for progress tracking).\\n\\n- **\`log(message)\`** — Log a message.\\n\\n- **\`readFile(path)\` / \`writeFile(path, content)\` / \`glob(pattern)\` / \`exists(path)\`** — File IO jailed to the workspace root.\\n\\n- **\`args\`** — The \`args\` value passed to \`run\`.\\n\\n- **\`fetch(url, opts?)\`** — Make an HTTP request. Returns \`{ ok, status, body }\`. \`opts\` can have \`method\`, \`headers\`, \`body\`. 15s timeout. Never throws — failures return \`{ ok: false, status: 0, body: errorMessage }\`.\\n\\n- **\`search(query)\`** — Web search. Returns an array of \`{ title, url, snippet }\`. Returns empty array when search is unavailable or fails. Never throws.\\n\\n- **\`exec(command, opts?)\`** — Execute a shell command. Returns \`{ stdout, stderr, exitCode }\`. \`opts\` can have \`timeoutMs\` (default 30s) and \`cwd\` (relative to workspace root). The command runs in the workspace directory. Never throws — non-zero exit codes are returned, not thrown.\\n\\n## When to use\\n\\n- **Deep research** — when the user wants a thorough, multi-source, fact-checked answer\\n- **Code review** — when the user wants a multi-dimensional review of code changes\\n- **Test generation** — when the user wants to add tests for existing untested code\\n- **Refactoring** — when the user wants to plan safe, incremental code improvements\\n- **Bug triage** — when the user reports an error, crash, or test failure\\n- **PR descriptions** — when the user needs to document code changes for a pull request\\n- **Architecture review** — when evaluating system design or detecting design decay\\n- **Security audit** — when auditing code for OWASP Top 10 vulnerabilities\\n- **Migration planning** — when upgrading dependencies or migrating between frameworks\\n- **Complex orchestration** — when a task requires multiple phases of parallel agent work\\n- **Structured pipelines** — when you need to chain agent outputs through transformation stages\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "run", "status", "wait", "cancel" ], "description": "The workflow operation to perform." }, "name": { "description": "Built-in or user workflow name (for \`run\`). Mutually exclusive with \`script\`.", "type": "string" }, "script": { "description": "Inline workflow script (for \`run\`). Mutually exclusive with \`name\`.", "type": "string" }, "args": { "description": "Arguments to pass to the workflow (for \`run\`).", "type": "string" }, "run_id": { "description": "Workflow run ID (for \`status\`, \`wait\`, \`cancel\`).", "type": "string" }, "timeout_ms": { "description": "Timeout in milliseconds (for \`wait\`).", "type": "number" }, "deadline_ms": { "description": "Total runtime limit in milliseconds for the script (for \`run\`). Defaults to 1800000 (30 minutes).", "type": "number" } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Use Write only for new files, complete replacements, or content with little continuity.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
      [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } } ] }
      [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } }, "time": "<time>" }
      [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
      [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot          { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Agent", "AgentSwarm", "AskUserQuestion", "Bash", "CreateGoal", "CronCreate", "CronDelete", "CronList", "Edit", "EnterSpecMode", "ExitPlanMode", "ExitSpecMode", "FetchURL", "GetGoal", "Glob", "Grep", "Knowledge", "Memory", "Read", "run_code", "session_query", "SetGoalBudget", "Skill", "SnapshotList", "TaskList", "TaskOutput", "TaskStop", "TodoList", "UpdateGoal", "WaitFor", "WebSearch", "Workflow", "Write" ], "time": "<time>" }
      [wire] llm.request                 { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "blocked" }
      [wire] usage.record                { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured     { "agentId": "main", "length": 3, "tokens": 8, "time": "<time>" }
      [emit] agent.status.updated        { "time": "<time>", "agentId": "main", "contextTokens": 8 }
      [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 1, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 3, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 5 }, "finishReason": "filtered", "providerFinishReason": "filtered", "rawFinishReason": "filtered" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "blocked" } }, "time": "<time>" }
      [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "filtered", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "filtered", "rawFinishReason": "filtered" }, "time": "<time>" }
      [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "blocked" } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 3, "output": 5, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "filtered", "rawFinishReason": "filtered" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
      [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "interruptReason": "filtered", "time": "<time>" }
      [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "failed", "error": { "code": "provider.filtered", "message": "Provider safety policy blocked the response.", "name": "ProviderFilteredError", "details": { "finishReason": "filtered" }, "retryable": false }, "interruptReason": "filtered" }"
    `);

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );

    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'filtered',
    });
  });

  it('marks a completed turn as truncated when the provider stops at max tokens', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial answer' }],
      finishReason: 'truncated',
      rawFinishReason: 'length',
    });

    const { turn } = submitTurn(loop, 'Hello');
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: true,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'max_tokens',
      providerFinishReason: 'truncated',
      rawFinishReason: 'length',
    });
    const turnEnded = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'completed' });
  });

  it('stops the turn when provider reports tool_calls without any tool call structure', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'done' }],
      finishReason: 'tool_calls',
    });

    const { turn } = submitTurn(loop, 'Hello');
    expect(turn).toBeDefined();

    await ctx.untilTurnEnd();
    await expect(turn.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });

    const stepCompleted = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
    );
    expect(stepCompleted?.args).toMatchObject({
      finishReason: 'other',
      providerFinishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    });
  });

  it('lets a loop error handler recover a non-context loop error by retrying', async () => {
    profile.update({ activeToolNames: [] });
    const workTool: ExecutableTool = {
      name: 'Work',
      description: 'Pretend to work.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Work',
        execute: async () => ({ output: 'should never run' }),
      }),
    };
    ctx.get(IAgentToolRegistryService).register(workTool);
    const seenErrors: Array<{ readonly step: number | undefined; readonly message: string }> = [];

    loop.registerLoopErrorHandler({
      id: 'test-recover-generate-error',
      match: () => true,
      handle: async (hookCtx) => {
        seenErrors.push({
          step: hookCtx.step,
          message: hookCtx.error instanceof Error ? hookCtx.error.message : String(hookCtx.error),
        });
        if (seenErrors.length === 1) {
          ctx.mockNextResponse({ type: 'text', text: 'Recovered.' });
          hookCtx.retry();
          return true;
        }
        return undefined;
      },
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(seenErrors).toEqual([{ step: 1, message: 'Unexpected generate call #1' }]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({ reason: 'completed' }),
      }),
    );

    profile.update({ activeToolNames: ['Work'] });
    const beforeExecuteError = new Error('beforeExecute blew up');
    const subscription = ctx.get(IAgentToolExecutorService).onBeforeExecuteTool(() => {
      throw beforeExecuteError;
    });
    ctx.mockNextResponse(
      { type: 'text', text: 'working' },
      { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
    );

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'use the tool' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();

    expect(seenErrors).toEqual([
      { step: 1, message: 'Unexpected generate call #1' },
      { step: 1, message: 'beforeExecute blew up' },
    ]);
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.ended',
        args: expect.objectContaining({
          reason: 'failed',
          error: expect.objectContaining({ message: 'beforeExecute blew up' }),
        }),
      }),
    );
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'context.append_loop_event',
        args: expect.objectContaining({
          event: expect.objectContaining({ type: 'step.end', finishReason: 'error' }),
        }),
      }),
    );
    expect(
      ctx.allEvents.filter(
        (entry) =>
          entry.type === '[wire]' &&
          entry.event === 'context.append_loop_event' &&
          (entry.args as { event?: { type?: string } }).event?.type === 'tool.result',
      ),
    ).toHaveLength(0);
    expect(ctx.llmCalls).toHaveLength(2);
  });

  it('reports an untyped LLM error message without an internal-code prefix', async () => {
    profile.update({ activeToolNames: [] });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.interrupted',
        args: expect.objectContaining({
          reason: 'error',
          message: 'Unexpected generate call #1',
        }),
      }),
    );
  });

  it('appends streamed partial content to the wire when the request fails mid-stream', async () => {
    profile.update({ activeToolNames: [] });
    ctx.mockNextProviderResponse({
      parts: [{ type: 'text', text: 'partial before error' }],
      error: new Error('stream broke mid-flight'),
    });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        type: '[wire]',
        event: 'context.append_loop_event',
        args: expect.objectContaining({
          event: expect.objectContaining({
            type: 'content.part',
            part: { type: 'text', text: 'partial before error' },
          }),
        }),
      }),
    );
    expect(ctx.allEvents).toContainEqual(
      expect.objectContaining({
        event: 'turn.step.interrupted',
        args: expect.objectContaining({ reason: 'error', message: 'stream broke mid-flight' }),
      }),
    );
  });

  it('does not run loop error handlers for aborted turns', async () => {
    let called = false;
    loop.registerLoopErrorHandler({
      id: 'test-abort-not-recoverable',
      match: () => {
        called = true;
        return true;
      },
      handle: async () => undefined,
    });
    const { turn } = submitTurn(loop, 'go');
    turn.cancel(new Error('stop'));

    const result = await turn.result;

    expect(result.type).toBe('cancelled');
    expect(called).toBe(false);
  });

  it('fails with the error handler error when recovery throws', async () => {
    const recoveryError = new Error('recovery failed');
    loop.registerLoopErrorHandler({
      id: 'test-throw-recovery-error',
      match: () => true,
      handle: async () => {
        throw recoveryError;
      },
    });

    const { turn } = submitTurn(loop, 'go');
    const result = await turn.result;

    expect(result.type).toBe('failed');
    if (result.type === 'failed') {
      expect(result.error).toBe(recoveryError);
    }
  });

  it('runs an agent turn through registered tool approval and execution', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    await ctx.rpc.prompt({
      input: [{ type: 'text', text: 'Look up moon' }],
    });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    expect(renderSnapshot(await ctx.untilApproval(true))).toMatchInlineSnapshot(`
      "[wire] tools.set_active_tools          { "agentId": "main", "names": [ "Lookup" ], "time": "<time>" }
      [emit] prompt.submitted                { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>" }
      [wire] turn.prompt                     { "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
      [emit] turn.prompt                     { "time": "<time>", "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0 }
      [emit] turn.started                    { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Look up moon" }
      [emit] context.spliced                 { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } } ] }
      [emit] prompt.started                  { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
      [wire] context.append_message          { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
      [wire] agent.message.appended          { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.started              { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
      [wire] tool_select.initialized         { "agentId": "main", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task in its own context.\\n\\nDo not launch a subagent unless the user explicitly asks for one, including delegation, parallel agents, or a named agent type. Explicit instructions in AGENTS.md or a skill, and user-enabled multi-agent modes, also authorize launching. Large or multi-part tasks and requests for depth, thoroughness, research, or investigation do not; do that work yourself. Agent type descriptions below guide selection only after authorization. Resuming already-authorized work needs no new request. Each subagent starts cold and re-derives context, costing time and tokens.\\n\\nWriting the prompt:\\n- Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups: put exact paths or commands you already know in the prompt.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nBackground agent execution is disabled for this agent. Do not set \`run_in_background=true\` — any call that sets it is rejected before the subagent launches. Run every subagent in the foreground and wait for its result.\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, Glob, Grep, WebSearch, FetchURL\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Bash, CronCreate, CronDelete, CronList, Edit, ExitSpecMode, Glob, Grep, Read, run_code, Skill, SnapshotList, TaskList, TaskOutput, TaskStop, TodoList, WaitFor, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases: it finds files by patterns (e.g. \\"src/**/*.yaml\\"), searches code for keywords (e.g. \\"database connection\\"), and answers questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions.\\n  Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nAgentSwarm runs only while swarm mode is on, and only the user can turn swarm mode on. When swarm mode is off, do not call AgentSwarm: the call is rejected and no subagents start.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out. Pass a flat object: keys are existing \`agent_id\` strings (as reported in a previous swarm's \`<subagent agent_id=\\"...\\">\` output), values are the continuation prompt for that subagent (usually \`\\"continue\\"\` if no extra information is needed). For example, with \`resume_agent_ids\` set to \`{\\"agent-coder-1\\": \\"continue\\", \\"agent-coder-2\\": \\"focus on the imports\\"}\`, AgentSwarm resumes those two existing subagents and spawns no new ones. You may combine \`resume_agent_ids\` with \`items\` to resume some and spawn others; resumed agents always run before fresh spawns and keep their original \`subagent_type\` and model. \`resume_agent_ids\` is a flat record — do not pass an array or a list of \`{item, prompt}\` objects, and do not use \`{{item}}\` as a key: that placeholder only applies to \`prompt_template\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Flat object: keys are existing subagent agent_id strings (from a previous swarm's \`<subagent agent_id=\\"...\\">\` result), values are the continuation prompt for that subagent (e.g. \\"continue\\"). Resumed subagents run before new item-based subagents. Do not pass an array or a list of {item, prompt} objects.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- Group related questions into one call to minimize interruptions\\n- List a recommended option first\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "description": "Whether the user can select multiple options.", "type": "boolean" }, "multiSelect": { "description": "Deprecated camelCase alias of multi_select; prefer multi_select.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." } }, "required": [ "questions" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, and anything the dedicated tools do not cover.\\n\\n- \`ls\` / \`find\` (list files) → \`Glob\`\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nEach call runs in a fresh shell: variables and \`cd\` do not persist, so pass \`cwd\` or use absolute paths. stdout and stderr are combined and may be truncated; a non-zero exit ends the output with \`Command failed with exit code: N\`. Do not run interactive commands or commands that never exit. Set \`timeout\` for possibly long-running commands. A command that hits its timeout is killed.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n- Use \`&&\` for commands that depend on each other. Issue independent read-only commands (separate \`git show\`, \`ls\`, or status checks) as parallel Bash calls in one response instead of chaining them or stitching their output with \`echo\` separators.\\n- Avoid \`..\` paths outside the working directory, and do not modify files outside it unless explicitly instructed.\\n- Do not use superuser privileges unless explicitly instructed. Run git-mutating commands such as \`git commit\`, \`git push\`, \`git reset\`, and \`git rebase\` only when the user asks for them.\\n- Command availability depends on the host; run \`which <command>\` before relying on an uncommon one. For GitHub work (PRs, issues, CI runs, API queries), prefer the \`gh\` CLI when installed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CreateGoal", "description": "Create a durable goal that the runtime pursues across multiple turns. Call it only when the user explicitly asks you to start a goal or work autonomously toward an outcome, or a host goal-intake prompt asks you to create one. Do not create a goal for greetings, ordinary questions, or requests without a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion first; if they clearly insist after you warn them that the wording is vague or risky, create the goal anyway. Include \`completionCriterion\` when the user provides one, or when it can be stated without inventing new requirements. Keep \`objective\` concise and reference long task descriptions by file path. Creating fails if a goal already exists; pass \`replace: true\` only when the user explicitly wants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronCreate", "description": "Schedule a prompt to be enqueued later in this session, recurring or once.\\n\\nWhen the requested time is approximate, avoid minute 0 and 30 so fires from many users do not land at once: \\"around 9\\" → \`57 8 * * *\`, \\"hourly\\" → \`7 * * * *\`.\\n\\nTasks fire only while this session is alive and idle, and never carry over to a new session. Missed fires collapse into one delivery with \`coalescedCount\` > 1: act on the latest state once. The final fire carries \`stale=\\"true\\"\`, so call CronCreate again with the same \`cron\` and \`prompt\` if the schedule is still wanted.\\n\\nUsers cannot manage cron tasks themselves: after creating one, tell the user its \`id\` and that they can ask you to cancel or change it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "cron": { "type": "string", "description": "5-field cron expression in local time: \\"M H DoM Mon DoW\\" (e.g. \\"*/5 * * * *\\" = every 5 minutes; \\"30 14 28 2 *\\" = Feb 28 at 2:30pm local — a pinned date like this repeats yearly unless you also pass recurring: false)." }, "prompt": { "type": "string", "minLength": 1, "maxLength": 8192, "description": "The prompt to enqueue at each fire time. Limited to 8 KiB (UTF-8)." }, "recurring": { "default": true, "description": "true (default) = fire on every cron match until deleted or auto-expired after 7 days. false = fire once at the next match, then auto-delete. Use false for \\"remind me at X\\" one-shot requests with pinned minute/hour/dom/month.", "type": "boolean" } }, "required": [ "cron", "prompt" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronDelete", "description": "Cancel a live cron task by its \`id\`. Fired one-shots and expired tasks are already gone; if an id is not found, call CronList instead of retrying it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "id": { "type": "string", "description": "The cron job id (ULID) returned by CronCreate / CronList." } }, "required": [ "id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "CronList", "description": "List this session's cron tasks. Read-only. \`stale: true\` marks a recurring task whose next fire is its last. After a context compaction, call this instead of guessing ids.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "EnterSpecMode", "description": "Use this tool when the user asks for a spec, or when a change is large enough that agreeing on the contract before writing code is worth a detour.\\n\\nGetting sign-off on a written spec before implementation prevents wasted effort: the user reviews requirements, design and tasks once, then you execute against that agreed contract instead of guessing.\\n\\n**What spec mode is for.** Plan mode produces a throwaway plan for one session. Spec mode writes documents that live in the repository, get committed alongside the code, and are read again by later sessions and teammates. Reach for it when the artifact should outlive this conversation.\\n\\n**Your workflow — write all four before calling ExitSpecMode:**\\n\\n1. Investigate with read-only tools (Read, Grep, Glob). Use Bash only when needed.\\n2. Write \`requirements.md\` — what to build. State the goal, who it is for, the boundaries, and explicitly what is *out of scope*. A requirement the user did not imply is a defect, not initiative.\\n3. Write \`design.md\` — how to build it. Name the concrete approach (files, functions, contracts), the technical constraints, and the trade-offs you rejected along with why.\\n4. Write \`tasks.md\` — how to verify it. Split the work into tasks small enough to finish and to check independently.\\n5. Call ExitSpecMode for approval. Nothing outside the spec directory can be written until the user approves.\\n\\n**Tasks must carry acceptance criteria.** A task that says \\"implement the export endpoint\\" cannot be verified. Write what must hold when it is done — the specific error, status, field, threshold or boundary that proves it. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is. Prefer criteria you can check by running something over criteria that need judgement.\\n\\n**Do not restate the project's global rules.** Conventions that already live in AGENTS.md / DEVELOP.md apply everywhere and belong there, not in a spec about one change. Reference them; do not copy them. A spec that repeats global rules goes stale the moment those rules move.\\n\\n**Keep the user in the loop on genuinely open questions.** If the requirements leave a decision that materially changes the design, ask before writing — an invented requirement buried in a spec is harder to notice than a question.\\n\\n**Constraints:**\\n- Writes are restricted to the spec directory until the user approves the spec; other edits are rejected. Call ExitSpecMode when the documents are ready.\\n- Do not create \`progress.md\` while in spec mode — it records implementation progress later, and this mode produces the three required documents above. Writes are not limited to those three: any file inside the spec directory is writable, so \`progress.md\` is accepted if the spec or the user calls for it.\\n- Plan, spec, swarm and tower modes are mutually exclusive. Entering spec mode leaves whichever of the others was active; the result names it, if any. You do not need to exit the other mode yourself.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitPlanMode", "description": "Request the user's approval of the plan you wrote to the plan file in plan mode. The tool reads the plan from that file and takes no plan content. The user reviews it before plan mode ends, in every permission mode, and can approve it, ask for revisions, or reject it; if they do not approve, revise the plan and call ExitPlanMode again.\\n\\nWrite the plan for a reviewer: they should be able to judge it quickly, and an implementer should be able to carry it out without making further decisions. Keep it concise, usually in these sections:\\n- Context — why the change is needed and the outcome it should produce.\\n- Approach — the approach you recommend. When the user must choose between genuinely different approaches, describe each briefly and pass them as \`options\`.\\n- Key changes — grouped by behavior or subsystem, not file by file. Name a file only when that makes a change unambiguous; for a change repeated across many files, describe the pattern once and list a few representative paths. Point to existing functions or utilities to reuse, with their paths.\\n- Verification — how to check the result end to end: the tests or commands to run and the scenario to exercise.\\n- Assumptions — each decision you made without the user's input, and the default you chose.\\nAvoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what changes and how you will know it works.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "ExitSpecMode", "description": "Use this tool when you are in spec mode and have finished writing the spec documents, and are ready for the user to review them.\\n\\n## How This Tool Works\\n- The requirements, design and tasks documents are read from the spec directory, not passed as parameters.\\n- The user sees all three when they review. In auto permission mode the tool exits spec mode without asking.\\n- All three must be non-empty. A missing or empty document is rejected, naming the file you still have to write.\\n\\n## When to Use\\nUse it only when the spec is genuinely ready to be approved. It does not verify the quality of what you wrote — it checks that the three documents exist and hands them to the user.\\n\\n## What a good spec contains\\n- **Requirements**: the goal, who it is for, the boundaries, and what is explicitly out of scope. A requirement the user did not imply is a defect.\\n- **Design**: the concrete approach — real files, functions and contracts — plus the trade-offs you rejected and why.\\n- **Tasks**: work split small enough to finish and to check, each with acceptance criteria. \\"Handles errors\\" is not a criterion; \\"returns 409 when the email already exists\\" is.\\n\\n## Multiple Approaches\\nIf the design document leaves a genuine choice between approaches, pass them via the \`options\` parameter so the user can pick which one to execute. Each option must correspond to an approach the design document actually describes.\\n\\n## After Approval\\nSpec mode ends and normal tool permissions return. Work through the tasks document, and record progress in the spec's progress file as you go. The progress file is a working note for whoever reads the spec next; it is not gated by this tool.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the design document leaves a genuine choice between approaches, list them here so the user can pick which one to execute. Provide up to 3 options; 2-3 distinct approaches work best. Each option must correspond to an approach the design document actually describes. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, budgets with what remains of each, and the terminal reason once it has stopped. Returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — recursive from the search root; \`src/*.ts\` — only directly inside \`src/\`\\n- \`src/**/*.ts\` — recursive beneath \`src/\`\\n- \`*.{ts,tsx}\` and \`{src,test}/**/*.ts\` — brace expansion\\n\\nFollow returned continuation offsets with unchanged search arguments. If results are partial, narrow the search and retry.\\n\\nAvoid broad searches in dependency or build-output directories, especially with \`include_ignored\`; prefer a narrow \`path\` or \`pattern\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "head_limit": { "description": "Maximum number of matching paths to return after offset. Defaults to 100. Pass 0 to remove the match-count limit. The character limit still applies: large pages are saved for Read, and a continuation offset is provided when more paths remain. Search time and output capture limits still apply.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of matching paths to skip. Defaults to 0. Each call searches the current filesystem again; changes can shift results between pages.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep to find unknown content or file locations; use Read directly when inspecting a known file's contents. Do not run \`grep\` or \`rg\` via shell: they bypass workspace policy, output limits, and sensitive-file filtering.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files are searched by default.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Knowledge", "description": "Use this tool to interact with the local knowledge base — a structured store of coding standards, pitfalls, architecture decisions, and workflow rules for the current project.\\n\\nThe knowledge base is automatically queried before each turn to inject relevant standards. You can also actively search, add, confirm, or reject entries.\\n\\nSub-commands (pass as the \`action\` parameter):\\n- \`search\`: Find entries relevant to a query, file path, or tags\\n- \`add\`: Record a new standard or pitfall discovered during work\\n- \`confirm\`: Upgrade an AI-learned entry to confirmed (confidence → 1.0)\\n- \`reject\`: Remove an incorrect or outdated entry\\n\\nWhen to use:\\n- After discovering a non-obvious constraint or convention: use \`add\`\\n- When the user corrects you and the correction is a reusable rule: use \`add\`\\n- When reviewing existing entries: use \`search\`\\n- To validate or dismiss auto-learned entries: use \`confirm\` or \`reject\`\\n\\nDo NOT use this tool for:\\n- General knowledge or facts (only project-specific standards)\\n- Temporary per-session preferences\\n- Information already in AGENTS.md (avoid duplication)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "add", "confirm", "reject" ] }, "query": { "type": "string" }, "scope": { "type": "string" }, "tags": { "type": "string" }, "id": { "type": "string" }, "title": { "type": "string" }, "category": { "type": "string", "enum": [ "coding-style", "pitfall", "architecture", "workflow" ] }, "content": { "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Memory", "description": "Search and manage persistent memory across sessions.\\n\\nMemory files are markdown documents stored under \`~/.kimi-code/memory/\`, organized by scope:\\n- **global** — cross-project knowledge (architecture decisions, coding standards, tool configs)\\n- **project** — project-specific knowledge tied to the current working directory\\n- **session** — session-specific notes and context\\n\\n## Actions\\n\\n### \`search\`\\nFull-text search over all memory entries. Returns matching snippets with scope and relevance score. Requires \`query\`.\\n\`\`\`\\nMemory({ action: \\"search\\", query: \\"authentication pattern\\" })\\n\`\`\`\\n\\n### \`read\`\\nRead a specific memory file by its relative path.\\n\`\`\`\\nMemory({ action: \\"read\\", path: \\"global/auth-pattern.md\\" })\\n\`\`\`\\n\\n### \`write\`\\nCreate or update a memory file. The \`scope\` determines where it lives:\\n- \`global\` — stored at \`~/.kimi-code/memory/global/\`\\n- \`project\` — stored at \`~/.kimi-code/memory/projects/<projectId>/\`\\n- \`session\` — stored at \`~/.kimi-code/memory/sessions/<sessionId>/\`\\n\\n\`\`\`\\nMemory({\\n  action: \\"write\\",\\n  scope: \\"project\\",\\n  path: \\"auth-pattern\\",\\n  content: \\"# Authentication Pattern\\\\n\\\\nUse JWT with refresh tokens...\\"\\n})\\n\`\`\`\\n\\n### \`list\`\\nList all memory files, optionally filtered by scope.\\n\`\`\`\\nMemory({ action: \\"list\\", scope: \\"global\\" })\\n\`\`\`\\n\\n### \`delete\`\\nDelete a memory file by its relative path.\\n\`\`\`\\nMemory({ action: \\"delete\\", path: \\"global/old-note.md\\" })\\n\`\`\`\\n\\n### \`log\`\\nList the memory repository's recent commits, newest first, each with its short\\nsha, date and message. Use it to pick a revision before \`revert\`.\\n\`\`\`\\nMemory({ action: \\"log\\" })\\n\`\`\`\\n\\n### \`revert\`\\nRoll one memory commit back. Takes the full \`sha\` reported by \`log\`; a short sha\\nis rejected. The search index is resynchronised from disk before the call\\nreturns, so a reverted file stops matching immediately.\\n\`\`\`\\nMemory({ action: \\"revert\\", sha: \\"<full sha>\\" })\\n\`\`\`\\n\\n## Scope semantics\\n\\n- \`search\` covers **every** project and session unless \`scope\` is given; pass\\n  \`scope\` to restrict it to the current project, the global scope, or this\\n  session.\\n- \`write\` defaults to \`project\` and never writes outside the scope you name.\\n- \`list\` defaults to everything; with \`scope\` it returns only that scope of the\\n  current project or session.\\n\\n\`project\` scope is keyed by the repository when there is one: the identity comes\\nfrom the \`origin\` remote first, then from the repository root, and only falls\\nback to the working directory path outside git. A repository with an \`origin\`\\nremote keeps the same project bucket after re-cloning, renaming or moving; a\\nrepository without one keeps it when you work from any directory inside it.\\n\\n## Git memory interaction\\n\\nWhen the \`git_memory\` experiment is enabled, \`write\` additionally requires the\\ncontent to cite a real commit: a 7–40 character hex string that \`git cat-file\`\\nresolves in the session working directory or in the memory repository. A write\\nwithout one is rejected. With the experiment on, every write and delete is\\ncommitted to that repository (\`remember:\`, \`update:\`, \`forget:\`), which is what\\n\`log\` lists and \`revert\` rolls back. With the experiment off, no such\\nrequirement applies and nothing is committed.\\n\\n## When to use\\n\\n- **Before starting a task** — search memory for relevant context from past sessions\\n- **After learning something important** — write it to memory for future reference\\n- **When you encounter a pattern or decision** — persist it so future you doesn't rediscover it\\n- **When debugging** — search for similar past issues and their resolutions\\n\\nMemory persists across sessions and projects. Use it to build up institutional knowledge.\\n\\nThe search index is rebuilt from the files on disk at most once every ten minutes, so\\na file edited outside this tool shows up in \`search\` and \`list\` within that window\\nrather than immediately.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "action": { "type": "string", "enum": [ "search", "read", "write", "list", "delete", "log", "revert" ], "description": "The memory operation to perform. Required." }, "query": { "description": "Search query (for \`search\` action).", "type": "string" }, "path": { "description": "Memory file path (for \`read\`, \`write\`, \`delete\`). Can include or omit \`.md\` extension. For \`read\`/\`delete\`, this is the full relative path (e.g. \`global/auth.md\`). For \`write\`, this is the filename within the chosen scope.", "type": "string" }, "scope": { "description": "Memory scope (for \`search\`, \`write\`, \`list\`). \`search\` defaults to every scope of every project; \`write\` defaults to \`project\`; \`list\` defaults to all scopes.", "type": "string", "enum": [ "global", "project", "session" ] }, "content": { "description": "Markdown content (for \`write\` action).", "type": "string" }, "sha": { "description": "Memory repository commit sha (for \`revert\` action).", "type": "string" } }, "required": [ "action" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "PowerShell", "description": "Execute a Windows PowerShell script natively (PowerShell 7 \`pwsh\` when available, otherwise Windows PowerShell 5.1). The script runs as a direct PowerShell process — it is not routed through bash.\\n\\n**When to use this instead of Bash:**\\n\\n- The task is inherently PowerShell: Windows registry, services, scheduled tasks, winget, WinGet/MSI installs, COM/WinRM, Windows event logs, NTFS ACLs, certificate store.\\n- You need PowerShell cmdlets or .NET types (\`Get-Service\`, \`Get-ItemProperty\`, \`[System.*]\`).\\n- You are on Windows and about to run \`powershell.exe\` / \`pwsh\` from the Bash tool — do not: the bash→native-PowerShell bridge re-encodes output and corrupts non-ASCII text. Use this tool instead; output is always decoded as UTF-8.\\n\\n**When to keep using Bash:** anything with POSIX shell semantics — pipes over coreutils, git, package managers of the project, build/test runners. File reads/edits/searches belong to \`Read\` / \`Edit\` / \`Glob\` / \`Grep\` regardless of platform.\\n\\n**Behavior:**\\n\\n- The script is passed as a single \`-EncodedCommand\` payload, so quoting and encoding are handled for you; write ordinary PowerShell script text. Interactive input is not supported.\\n- The session runs with \`-NoProfile -NonInteractive\`. Output encoding is pinned to UTF-8, so non-ASCII text (including Chinese) comes back clean.\\n- stdout and stderr are combined and returned as a string. The output may be truncated if it is too long. A non-zero exit ends the result with a \`Command failed with exit code: N\` line; a script killed by its timeout or interrupted by the user ends with its own message instead.\\n- Each call runs in a fresh process: variables and location do not persist between calls. To run in a particular directory, pass the \`cwd\` argument.\\n- Foreground calls default to 60s and allow up to 300s; a foreground call that hits its timeout is moved to the background instead of being killed.\\n\\nBackground execution is disabled for this agent. Do not set \`run_in_background=true\`.\\n\\n**Safety:** do not use this tool to escape the working directory, to modify files outside of it unless instructed, or to run commands that require superuser privileges unless explicitly instructed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The PowerShell script to execute." }, "cwd": { "description": "The working directory in which to run the script. When omitted, the script runs in the session's working directory.", "type": "string" }, "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991, "description": "Optional timeout in seconds for the script to execute." }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the script as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the script. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Read", "description": "Read a text file from the active environment's filesystem. Do not fully trust comments and documentation.\\n\\nThe path may be a \`kimi-file://\` attachment reference. Its bytes come from the current session's storage, independently of the workspace environment. Next Read keeps the reference so pagination also works after a fork. For a binary attachment, the error includes a server-local path when available; a converter must be able to access that filesystem. ReadMediaFile accepts the same reference for images and videos.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Output is \`<line-number>\\\\t<content>\` per line. A \`<system>\` status block may follow; it is not part of the file.\\n- Results are bounded by \`max_chars\`: 100000 by default, up to 500000, and by about 500000 divided by four estimated tokens.\\n- If the status block reports an incomplete range, continue with its \`Next Read\` arguments exactly. Do not answer from a partial page when the task requires the remaining content.\\n- **Images and videos** (max 100MB) are sent to the model as multimodal media instead of text; this requires a model with the matching vision capability (\`image_in\` / \`video_in\`). \`region\` and \`full_resolution\` apply only to images; \`line_offset\` and \`n_lines\` apply only to text files.\\n- Large images are downsampled by default when automatic compression can safely fit them within model limits, which can blur fine detail (small text, dense UI). Compute absolute coordinates from the original dimensions reported in the \`<system>\` block, never by measuring the displayed copy. When the \`<system>\` tag reports downsampling and you need that detail, call Read again with the \`region\` parameter (original-image pixel coordinates) to view a crop at full fidelity, or set \`full_resolution\` to true when the whole file fits the per-image byte limit. Re-reading the same file without these parameters just reproduces the same downsampled image.\\n- If automatic compression cannot safely produce an image within model limits, the tool returns an error and does not send the original image. Follow the error: use Bash or an available image-processing tool to create a smaller copy, then read that copy. Do not retry the unchanged file.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a file or a kimi-file:// attachment reference in the current session. Text files are read as text; image and video files are sent to the model as multimodal content (requires a model with the matching vision capability). Relative filesystem paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file (for example, -100 reads the last 100 lines).", "type": "integer", "minimum": -9007199254740991, "maximum": 9007199254740991 }, "column_offset": { "description": "Zero-based character offset within the first line of a forward read, excluding its line-number prefix. Uses JavaScript string length in the displayed text. Copy continuation arguments from the previous result to resume a long line.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "n_lines": { "description": "The number of lines to read. Omit to read toward the end of the file. Results are bounded by max_chars, with continuation arguments when the requested range is incomplete.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "region": { "description": "Images only: view just this rectangle of the image (original-image pixel coordinates). Use after a downsampled full view to inspect fine detail — a region within the size limits is delivered at full fidelity.", "type": "object", "properties": { "x": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Left edge of the crop, in original-image pixels." }, "y": { "type": "integer", "minimum": 0, "maximum": 9007199254740991, "description": "Top edge of the crop, in original-image pixels." }, "width": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop width, in original-image pixels." }, "height": { "type": "integer", "minimum": 1, "maximum": 9007199254740991, "description": "Crop height, in original-image pixels." } }, "required": [ "x", "y", "width", "height" ], "additionalProperties": false }, "full_resolution": { "description": "Images only: skip the default downscaling and view at native resolution. Fails with an explicit error when the payload would exceed the per-image byte limit; use region for files that large.", "type": "boolean" }, "max_chars": { "description": "Maximum characters in the returned text, including line numbers and status. Omit for the configured default; requests above the configured maximum are capped.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "run_code", "description": "Run a TypeScript/JavaScript program in an isolated subprocess and return its console output and completion value.\\n\\n- The program body runs as an async function: top-level \`await\` and \`return\` work (e.g. \`return 1 + 2\`, \`await fetch(...).then(r => r.json())\`).\\n- \`console.log\` / \`console.info\` / \`console.warn\` / \`console.error\` / \`console.debug\` output is captured in emission order.\\n- The completion value must be JSON-serializable (objects, arrays, strings, numbers, booleans, null). \`undefined\` (e.g. a bare \`return\`) reports \`value: undefined\`. Functions, classes, and circular structures fail with an \`invalid-output\` error.\\n- No state survives between calls — each run spawns a fresh subprocess.\\n- The subprocess runs under a memory cap; a program that exceeds it fails with a \`memory-limit\` error and cannot take the host down with it.\\n- The subprocess is a soft isolation boundary, NOT a security sandbox: treat model-written code with the same trust level as a Bash command.\\n- Prefer this tool over Bash for pure computation, data transformation, algorithm verification, parsing, and small scripting tasks that do not need shell features.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "code": { "type": "string", "minLength": 1, "description": "The TypeScript/JavaScript program to run. The body executes as an async function, so top-level await and return work. console.log/info/warn/error/debug output is captured." }, "timeout_ms": { "default": 30000, "description": "Execution budget in milliseconds before the worker is terminated (default 30000).", "type": "integer", "minimum": 1000, "maximum": 120000 } }, "required": [ "code" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "select_tools", "description": "Load tools by exact name, or search for them by capability when the name is unknown. The loadable names are listed in the <tools_added>/<tools_removed> or <tools_relevant> announcements in the system context — use the latest announcement. If you have not seen a loadable-tools announcement in this session, no tools are currently loadable. Pass names to load them, or pass query to search all loadable tools; a search returns candidates only, so call select_tools again with exact names to load the ones you need. The full definitions become available immediately, so you can call them directly in your next tool call. Tools you already have available are called directly, never passed to select_tools.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "names": { "description": "Exact tool names to load, taken from the latest announcement or a prior search result.", "minItems": 1, "type": "array", "items": { "type": "string" } }, "query": { "description": "Capability description to search for when the exact tool name is unknown; returns candidates without loading them.", "type": "string", "minLength": 1 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "session_query", "description": "Search prior session history: cross-session full-text search over your own workspace's sessions, within-session event search, and fork-lineage tracing.\\n\\nOperations:\\n- \`session_search\`: full-text search across the workspace's sessions. The \`query\` is a literal phrase; results rank sessions by the strongest matching event and include a bounded snippet. Optional filters narrow the corpus: \`session_ids\`, \`created_at_from\`/\`created_at_to\` (inclusive ISO 8601), \`parent_session_ids\`, \`include_root_sessions\`, \`availability\` (\`live\`/\`persisted\`), and event bounds \`event_seq_from\`/\`event_seq_to\`/\`event_time_from\`/\`event_time_to\`/\`event_types\`.\\n- \`event_search\`: full-text search within one session's events (omit \`session_id\` for the current session). Same query semantics; optional \`seq_from\`/\`seq_to\`/\`time_from\`/\`time_to\`/\`event_types\` bounds.\\n- \`session_trace\`: fork lineage of one session (omit \`session_id\` for the current session) — the ancestor chain and descendant trees.\\n\\nQueries are interpreted as data, never as query syntax. Results are capped at 20 entries; narrow the query or add filters to find more.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "session_search", "event_search", "session_trace" ], "description": "Which session-query operation to run: session_search (cross-session full-text search), event_search (within-session event search), or session_trace (fork lineage of one session)." }, "operationArgs": { "description": "Operation-specific arguments (validated per operation).", "type": "object", "propertyNames": { "type": "string" }, "additionalProperties": {} } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SetGoalBudget", "description": "Set a hard budget for the current goal, only when the user clearly states one, such as \\"stop after 20 turns\\", \\"use no more than 500k tokens\\", or \\"finish within 30 minutes\\". Do not invent limits, and do not set one for vague wording such as \\"spend some time\\" or \\"try to be quick\\". Convert a compound time to one unit first: \\"2 hours and 3 minutes\\" → \`value: 123, unit: \\"minutes\\"\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, copied verbatim from the current skill listing." }, "path": { "description": "Optional exact Path from the current skill listing, used to select a same-name variant.", "type": "string" }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "SnapshotList", "description": "List the versions this session recorded for a file before it was overwritten.\\n\\nWrite and Edit keep a record of the content they replace. This tool reads that record for one path and answers who replaced it, when, and in which session or subagent: each line carries the time, the tool that wrote, the size, a short content hash, and the agent that did it. Versions come newest first; index 1 is the most recent overwrite.\\n\\nIt never returns the recorded content. To put a version back, the user runs \`kimi snapshot restore <path> --previous\` (or \`--hash <sha|id>\` for a specific one).\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "minLength": 1, "description": "File path whose recorded versions to list, as written in the tool call or absolute. The newest version comes first." } }, "required": [ "path" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskList", "description": "List background tasks and their current status, including task IDs for \`TaskOutput\`.\\n\\nAfter context compaction, or whenever unsure which tasks are running, call TaskList instead of guessing IDs. With \`active_only=false\`, \`lost\` tasks from previous processes may appear; treat them as terminated.\\n\\nThis tool is read-only and safe in plan mode; it does not return task output.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskOutput", "description": "Retrieve a non-blocking snapshot of a running or completed background task.\\n\\nUse after \`Bash(run_in_background=true)\`, \`Agent(run_in_background=true)\`, or \`AskUserQuestion(background=true)\` to check progress or read completed output. Prefer automatic completion notifications over polling. If your next step depends on task completion, run the task in the foreground instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. The list is shown to the user as a live progress panel, so keep it in step with what you have actually done. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Keeping it current:**\\n- Before you start a tracked task, mark it \`in_progress\`; while work is underway, keep exactly one task \`in_progress\`.\\n- As soon as a task is finished, mark it \`done\`, before you start the next one. Do not batch completions at the end.\\n- Before you write your final message, make sure the list matches what you actually did.\\n- An update can go in the same response as your next tool call; it does not need a step of its own.\\n- Do not re-send an unchanged list. If you are stuck and no available tool can move any task forward, tell the user instead of re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "id": { "description": "Stable identifier of the item, as returned by a previous call. Reuse it so an update lands on the same item instead of creating a new one. Omit on first write; missing ids are assigned as T1, T1.1, and so on.", "type": "string" }, "parentId": { "description": "Id of the milestone this item belongs to. Null or omitted for milestones and for a flat list.", "anyOf": [ { "type": "string" }, { "type": "null" } ] }, "kind": { "description": "Milestone groups leaf tasks; task is a leaf unit of work. Defaults to task.", "type": "string", "enum": [ "milestone", "task" ] }, "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." }, "progress": { "description": "Completion percentage 0-100 of an in_progress leaf task. Omit on milestones (computed from children) and on done items (implies 100).", "type": "number", "minimum": 0, "maximum": 100 }, "description": { "description": "Optional longer note about the item.", "type": "string" } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "UpdateGoal", "description": "Set the status of the current goal. \`active\` resumes a paused or blocked goal when the user explicitly asks you to work on it again. \`complete\` and \`blocked\` end autonomous work: while a goal is active, its full reminder states exactly when each one is warranted; later reminders keep the current goal state and point back to those rules. Follow them, and do not call this tool merely because you finished a slice of work. After \`complete\` or \`blocked\`, write the completion summary or the blocker explanation in your next message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WaitFor", "description": "Wait for background tasks to finish without ending the current turn.\\n\\nOnly call this tool when you really have no other work to do and your next step cannot proceed without the result of a running background task (a sub-agent, a background bash command, or a background AskUserQuestion). The call suspends inside the current turn until the task finishes or the timeout elapses, then returns the outcome so you can keep working in the same turn. While waiting, no LLM requests are made, but the user is kept waiting too.\\n\\nWhen background tasks finish, they notify you automatically, so you do not need to busily wait for them.\\n\\nGuidelines:\\n\\n- Before calling WaitFor, think about what else you can do meanwhile: another part of the task, verifying earlier work, or ending your turn with a progress update. If there is anything, do that instead.\\n- Do not call WaitFor right after dispatching work whose result you do not need yet.\\n- After a timeout, prefer moving on to other work over calling WaitFor again; repeated waits keep the user waiting.\\n- Without \`task_id\`, tasks started during the wait are not covered by it; their completion arrives via the usual automatic notification.\\n- With \`task_id\`, the wait ends when that task finishes. An unknown \`task_id\` is an error; a task that has already finished returns immediately.\\n- When no background tasks are running, WaitFor returns immediately without waiting.\\n- Waiting has no side effects on the waited tasks: WaitFor never stops a task, and interrupting the wait (for example, a new user message) leaves every task running.\\n- A finished task's result is delivered exactly once: tasks reported by WaitFor do not also produce an automatic completion notification.\\n- You can only wait for background tasks started by this agent; task IDs belonging to other agents are unknown here.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "timeout": { "type": "integer", "exclusiveMinimum": 0, "maximum": 90, "description": "Maximum time to wait, in seconds (1-90). Pick it from how long you expect the task to take, not the maximum. A timeout is not an error: the tool returns the tasks that are still running." }, "task_id": { "description": "The background task ID to wait for. When omitted, the wait ends as soon as any background task that was running at call time finishes.", "type": "string" } }, "required": [ "timeout" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "WebSearch", "description": "Search the web for information. Use this when you need up-to-date information from the internet.\\n\\nEach result includes its title, its URL, and a snippet, plus its source site and publication date when available. Results are short summaries, not full pages — when a result looks relevant, call the FetchURL tool on its URL to read the full page content. Fetch only the few URLs you actually need. Prefer specific queries, and refine the query if the results don't contain what you need.\\n\\nWhen you rely on a result in your answer, cite its source URL so the user can verify it.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "query": { "type": "string", "description": "The query text to search for." } }, "required": [ "query" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Workflow", "description": "Run multi-phase orchestrated agent workflows.\\n\\n## Operations\\n\\n### \`run\` — start a workflow\\nLaunches a workflow in the background. Returns immediately with a \`run_id\`; the result is delivered as a notification when the workflow completes.\\n\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"How does RAG compare to fine-tuning?\\" })\\n\`\`\`\\n\\nYou can also run an inline script:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", script: \\"export const meta = { name: 'quick', description: '...' };\\\\nphase('search');\\\\nconst result = await agent('Search for...');\\\\nreturn result;\\", args: \\"...\\" })\\n\`\`\`\\n\\nThe script runs under a 30-minute default deadline, counted from launch and covering the whole script, not just its synchronous start. Pass \`deadline_ms\` to raise or lower it for a single run — a long workflow that intentionally runs for hours must ask for the time it needs:\\n\`\`\`\\nWorkflow({ operation: \\"run\\", name: \\"deep-research\\", args: \\"...\\", deadline_ms: 7200000 })\\n\`\`\`\\nA script that exceeds the deadline is aborted: the run ends as \`failed\` with \`Workflow script deadline exceeded\`, and any subagent it started is cancelled. The same applies to a script stuck in a tight synchronous loop with no \`await\`: that kind of loop blocks the process it runs in, so it is cut off at 30 seconds and the run fails.\\n\\n### \`status\` — check progress\\n\`\`\`\\nWorkflow({ operation: \\"status\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n### \`wait\` — block until done\\n\`\`\`\\nWorkflow({ operation: \\"wait\\", run_id: \\"wf_1\\", timeout_ms: 60000 })\\n\`\`\`\\n\\n### \`cancel\` — cancel a running workflow\\n\`\`\`\\nWorkflow({ operation: \\"cancel\\", run_id: \\"wf_1\\" })\\n\`\`\`\\n\\n## Built-in workflows\\n\\n- **deep-research** — Multi-source research with adversarial jury fact-checking. Plans search lines, runs parallel web searches, extracts facts from top sources, cross-checks each fact with 3 jurors (majority reject drops it), and writes a cited report.\\n- **code-review** — Multi-dimensional code review across security, performance, correctness, and maintainability. Runs parallel reviewers and produces a consolidated severity-ranked report.\\n- **test-generator** — Automated test generation. Analyzes source code, plans test cases, generates test files with proper mocks, and validates output.\\n- **refactor-planner** — Refactoring impact analysis and migration planner. Identifies improvement opportunities, assesses risk, and generates a phased plan with rollback steps.\\n- **bug-triage** — Automated bug triage. Parses error logs and stack traces, reads suspect source files, identifies root causes, and generates fixes with reproduction steps.\\n- **pr-description** — PR description generator. Analyzes code diffs, extracts semantic intent, and generates a comprehensive PR body with changelog entries and reviewer guidance.\\n- **architecture-review** — Architecture and dependency analysis. Detects circular dependencies, measures coupling, identifies layer violations, and generates architecture documentation.\\n- **security-audit** — Security vulnerability audit. Scans for OWASP Top 10, hardcoded secrets, injection points, auth flaws, and produces a prioritized remediation plan.\\n- **migration-planner** — Migration and upgrade planner. Analyzes dependency versions, identifies breaking changes, maps code changes, and generates a phased migration plan with compatibility shims.\\n\\n## In-script primitives\\n\\nWorkflow scripts are JavaScript that runs in a sandbox with these injected globals:\\n\\n- **\`agent(prompt, opts?)\`** — Spawn a subagent. Returns the agent's result (parsed JSON if \`opts.schema\` given, else text) or \`null\` on failure. **Never throws.**\\n  - \`opts.agentType\` — subagent profile (default 'coder')\\n  - \`opts.schema\` — JSON schema for structured output\\n  - \`opts.label\` — display label\\n\\n- **\`parallel(thunks)\`** — Run thunks concurrently. Returns array of results.\\n\\n- **\`pipeline(items, ...stages)\`** — Run each item through all stages. No barrier between stages — items flow through independently.\\n\\n- **\`phase(title)\`** — Set the current phase (for progress tracking).\\n\\n- **\`log(message)\`** — Log a message.\\n\\n- **\`readFile(path)\` / \`writeFile(path, content)\` / \`glob(pattern)\` / \`exists(path)\`** — File IO jailed to the workspace root.\\n\\n- **\`args\`** — The \`args\` value passed to \`run\`.\\n\\n- **\`fetch(url, opts?)\`** — Make an HTTP request. Returns \`{ ok, status, body }\`. \`opts\` can have \`method\`, \`headers\`, \`body\`. 15s timeout. Never throws — failures return \`{ ok: false, status: 0, body: errorMessage }\`.\\n\\n- **\`search(query)\`** — Web search. Returns an array of \`{ title, url, snippet }\`. Returns empty array when search is unavailable or fails. Never throws.\\n\\n- **\`exec(command, opts?)\`** — Execute a shell command. Returns \`{ stdout, stderr, exitCode }\`. \`opts\` can have \`timeoutMs\` (default 30s) and \`cwd\` (relative to workspace root). The command runs in the workspace directory. Never throws — non-zero exit codes are returned, not thrown.\\n\\n## When to use\\n\\n- **Deep research** — when the user wants a thorough, multi-source, fact-checked answer\\n- **Code review** — when the user wants a multi-dimensional review of code changes\\n- **Test generation** — when the user wants to add tests for existing untested code\\n- **Refactoring** — when the user wants to plan safe, incremental code improvements\\n- **Bug triage** — when the user reports an error, crash, or test failure\\n- **PR descriptions** — when the user needs to document code changes for a pull request\\n- **Architecture review** — when evaluating system design or detecting design decay\\n- **Security audit** — when auditing code for OWASP Top 10 vulnerabilities\\n- **Migration planning** — when upgrading dependencies or migrating between frameworks\\n- **Complex orchestration** — when a task requires multiple phases of parallel agent work\\n- **Structured pipelines** — when you need to chain agent outputs through transformation stages\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "operation": { "type": "string", "enum": [ "run", "status", "wait", "cancel" ], "description": "The workflow operation to perform." }, "name": { "description": "Built-in or user workflow name (for \`run\`). Mutually exclusive with \`script\`.", "type": "string" }, "script": { "description": "Inline workflow script (for \`run\`). Mutually exclusive with \`name\`.", "type": "string" }, "args": { "description": "Arguments to pass to the workflow (for \`run\`).", "type": "string" }, "run_id": { "description": "Workflow run ID (for \`status\`, \`wait\`, \`cancel\`).", "type": "string" }, "timeout_ms": { "description": "Timeout in milliseconds (for \`wait\`).", "type": "number" }, "deadline_ms": { "description": "Total runtime limit in milliseconds for the script (for \`run\`). Defaults to 1800000 (30 minutes).", "type": "number" } }, "required": [ "operation" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Use Write only for new files, complete replacements, or content with little continuity.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false }, "source": "builtin", "origin": "initial" } ], "time": "<time>" }
      [emit] context.spliced                 { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } } ] }
      [wire] context.append_message          { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<system-reminder>\\nNo tools are currently available for dynamic loading in this session. Do not call select_tools or guess tool names; use the tools you already have. Only a later <tools_added> announcement can make new tools loadable.\\n</system-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "loadable-tools", "disclosure": { "kind": "snapshot", "revision": 0, "tools": [] } } }, "time": "<time>" }
      [wire] plugin.session_start            { "agentId": "main", "content": null, "time": "<time>" }
      [emit] turn.step.started               { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
      [wire] context.append_loop_event       { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
      [wire] llm.tools_snapshot              { "agentId": "main", "hash": "<tools-hash>", "tools": [ "Lookup" ], "time": "<time>" }
      [wire] llm.request                     { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 1, "turnStep": "0.1", "time": "<time>" }
      [emit] assistant.delta                 { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will look it up." }
      [emit] tool.call.delta                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
      [wire] usage.record                    { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured         { "agentId": "main", "length": 3, "tokens": 20, "time": "<time>" }
      [emit] agent.status.updated            { "time": "<time>", "agentId": "main", "contextTokens": 20 }
      [wire] context.append_loop_event       { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
      [emit] permission.approval.requested   { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" } }
      [wire] interaction.request             { "agentId": "main", "id": "<approval-1>", "kind": "approval", "toolCallId": "call_lookup", "request": { "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }, "time": "<time>" }
      [emit] requestApproval                 { "id": "<approval-1>", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } } }"
    `);
    expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
    "system: <system-prompt>
    tools: Lookup
    messages:
      user: text "Look up moon""
  `);

    expect(renderSnapshot(await ctx.untilTurnEnd())).toMatchInlineSnapshot(`
      "[wire] interaction.resolved                { "agentId": "main", "id": "<approval-1>", "response": { "decision": "approved", "selectedLabel": "approve" }, "time": "<time>" }
      [emit] permission.approval.resolved        { "time": "<time>", "id": "<approval-1>", "sessionId": "test-session", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "display": { "kind": "generic", "summary": "Approve Lookup", "detail": { "query": "moon" } }, "toolInput": { "query": "moon" }, "decision": "approved", "selectedLabel": "approve" }
      [wire] permission.record_approval_result   { "turnId": 0, "toolCallId": "call_lookup", "toolName": "Lookup", "action": "Approve Lookup", "result": { "decision": "approved", "selectedLabel": "approve" }, "agentId": "main", "time": "<time>" }
      [emit] tool.call.started                   { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
      [emit] tool.result                         { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "output": "lookup-result" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "lookup-result" } }, "time": "<time>" }
      [emit] turn.step.completed                 { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 1, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 4, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 16 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
      [emit] turn.step.started                   { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
      [wire] llm.request                         { "agentId": "main", "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "<tools-hash>", "messageCount": 3, "turnStep": "0.2", "time": "<time>" }
      [emit] assistant.delta                     { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The lookup result is lookup-result." }
      [wire] usage.record                        { "agentId": "main", "model": "mock-model", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
      [emit] agent.status.updated                { "time": "<time>", "agentId": "main", "usage": { "byModel": { "mock-model": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 29, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
      [wire] token_counting.measured             { "agentId": "main", "length": 5, "tokens": 37, "time": "<time>" }
      [emit] agent.status.updated                { "time": "<time>", "agentId": "main", "contextTokens": 37 }
      [emit] turn.step.completed                 { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "cache": { "modelAlias": "mock-model", "protocol": "openai", "providerType": "kimi", "messageCount": 3, "historyHash": "<fingerprint>", "thinkingEffort": "off", "inputTokens": 25, "cacheRead": 0, "cacheCreation": 0, "outputTokens": 12 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The lookup result is lookup-result." } }, "time": "<time>" }
      [wire] context.append_loop_event           { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
      [wire] agent.message.appended              { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 4, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
      [wire] agent.message.appended              { "message": { "message": { "role": "tool", "content": [ { "type": "text", "text": "lookup-result" } ], "toolCallId": "call_lookup" }, "meta": { "source": "tool" } }, "time": "<time>", "kind": "event" }
      [wire] agent.message.appended              { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is lookup-result." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 25, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-2" } }, "time": "<time>", "kind": "event" }
      [wire] agent.turn.ended                    { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
      [wire] turn.ended                          { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
      [emit] turn.ended                          { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }"
    `);
    expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
      "messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "lookup-result""
    `);
  });

  it('carries the engine cache-break verdict on turn.step.completed', async () => {
    const toolCall: ToolCall = {
      type: 'function',
      id: 'call_echo',
      name: 'Echo',
      arguments: '{}',
    };
    const echoTool: ExecutableTool = {
      name: 'Echo',
      description: 'Echo a value.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Echo',
        execute: async () => ({ output: 'ok' }),
      }),
    };
    let calls = 0;
    const generate = requesterFromGenerateFn(async (): Promise<LegacyGenerateResult> => {
      calls += 1;
      if (calls === 1) {
        return {
          id: 'mock-cache-1',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'calling echo' }],
            toolCalls: [toolCall],
          },
          usage: { inputOther: 10, output: 5, inputCacheRead: 10_000, inputCacheCreation: 0 },
          finishReason: 'tool_calls',
          rawFinishReason: 'tool_calls',
        };
      }
      return {
        id: 'mock-cache-2',
        message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], toolCalls: [] },
        usage: { inputOther: 10, output: 5, inputCacheRead: 1_000, inputCacheCreation: 0 },
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    });
    const local = createTestAgent(permissionModeServices('yolo'), { generate });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: ['Echo'] });
      local.get(IAgentToolRegistryService).register(echoTool);
      const breaks: CacheBreakObservation[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnStepCompleted && event.cacheBreak !== undefined) {
          breaks.push(event.cacheBreak);
        }
      });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'echo' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(breaks).toHaveLength(1);
      expect(breaks[0]).toMatchObject({
        cause: 'unexplained',
        previous: { usage: { inputCacheRead: 10_000 } },
        current: { usage: { inputCacheRead: 1_000 } },
      });
    } finally {
      await local.dispose();
    }
  });

  it('does not abort sibling tools when a parallel batch tool completes first', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    const slowGate = deferred();
    try {
      const slowStarted = deferred();
      let slowSawAbort: boolean | undefined;
      const fastTool: ExecutableTool = {
        name: 'Fast',
        description: 'Return immediately.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Fast',
          execute: async () => ({ output: 'fast result' }),
        }),
      };
      const slowTool: ExecutableTool = {
        name: 'Slow',
        description: 'Wait on a gate before returning.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Slow',
          execute: async ({ signal }) => {
            slowStarted.resolve();
            await slowGate.promise;
            slowSawAbort = signal.aborted;
            return { output: 'slow result' };
          },
        }),
      };
      local.get(IAgentProfileService).update({ activeToolNames: ['Fast', 'Slow'] });
      local.get(IAgentToolRegistryService).register(fastTool);
      local.get(IAgentToolRegistryService).register(slowTool);

      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-fast-1', name: 'Fast', arguments: '{}' },
        { type: 'function', id: 'call-slow-1', name: 'Slow', arguments: '{}' },
      );
      local.mockNextResponse({ type: 'text', text: 'all done' });

      const toolResults = (): Array<Extract<LoopRecordedEvent, { type: 'tool.result' }>> =>
        local.allEvents
          .filter((entry) => entry.type === '[wire]' && entry.event === 'context.append_loop_event')
          .map((entry) => (entry.args as { event: LoopRecordedEvent }).event)
          .filter(
            (event): event is Extract<LoopRecordedEvent, { type: 'tool.result' }> =>
              event.type === 'tool.result',
          );

      const { turn } = submitTurn(local.get(IAgentLoopService), 'use both tools');
      await slowStarted.promise;
      await waitForAssertion(() => {
        expect(toolResults().some((event) => event.toolCallId === 'call-fast-1')).toBe(true);
      });
      slowGate.resolve();
      await expect(turn.result).resolves.toMatchObject({ type: 'completed' });

      expect(slowSawAbort).toBe(false);
      expect(
        toolResults()
          .map((event) => event.toolCallId)
          .toSorted(),
      ).toEqual(['call-fast-1', 'call-slow-1']);
      await local.expectResumeMatches();
    } finally {
      slowGate.resolve();
      await local.dispose();
    }
  });

  it('forwards the cancellation reason to the signals of running tools', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    try {
      const started = deferred();
      const signals: AbortSignal[] = [];
      const hangTool: ExecutableTool = {
        name: 'Hang',
        description: 'Wait until aborted.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Hang',
          execute: ({ signal }) => {
            signals.push(signal);
            started.resolve();
            return new Promise((_, reject) => {
              signal.addEventListener('abort', () => reject(signal.reason), { once: true });
            });
          },
        }),
      };
      local.get(IAgentProfileService).update({ activeToolNames: ['Hang'] });
      local.get(IAgentToolRegistryService).register(hangTool);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-hang-1', name: 'Hang', arguments: '{}' },
      );

      const loop = local.get(IAgentLoopService);
      const { turn } = submitTurn(loop, 'hang until cancelled');
      await started.promise;

      expect(loop.cancel()).toBe(true);
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      expect(signals).toHaveLength(1);
      expect(signals[0]?.aborted).toBe(true);
      expect(isUserCancellation(signals[0]?.reason)).toBe(true);
    } finally {
      await local.dispose();
    }
  });

  it('preserves tool call extras (Gemini thought_signature) through to context', async () => {
    const sigCall: ToolCall = {
      type: 'function',
      id: 'call_sig',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
      extras: { thought_signature_b64: 'c2lnbmF0dXJl' },
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };

    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, sigCall);
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
    ctx.mockNextResponse({ type: 'text', text: 'The lookup result is lookup-result.' });
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    const assistant = ctx.contextData().history.find((m) => m.role === 'assistant');
    expect(assistant?.toolCalls[0]?.extras).toEqual({ thought_signature_b64: 'c2lnbmF0dXJl' });
  });

  it('lets non-external stop hooks continue a turn more than once', async () => {
    profile.update({ activeToolNames: [] });
    let continuations = 0;
    loop.hooks.onDidFinishStep.register('test-repeat-stop-continuation', async (hookCtx, next) => {
      if (continuations < 2) {
        continuations += 1;
        loop.notify({
          message: {
            role: 'user',
            content: [{ type: 'text', text: `continue ${continuations}` }],
            toolCalls: [],
            origin: { kind: 'system_trigger', name: 'stop_hook' },
          },
        });
        return;
      }
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextProviderResponse({ error: new APIProviderRateLimitError('slow down', null, 1) });
    ctx.mockNextResponse({ type: 'text', text: 'Second answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'Third answer.' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(continuations).toBe(2);
    expect(ctx.llmCalls).toHaveLength(4);
    const startedSteps = ctx.allEvents
      .filter((event) => event.type === '[rpc]' && event.event === 'turn.step.started')
      .map((event) => (event.args as { step: number }).step);
    expect(startedSteps).toEqual([1, 2, 3, 4]);
    const retryingSteps = ctx.allEvents
      .filter((event) => event.type === '[rpc]' && event.event === 'turn.step.retrying')
      .map((event) => (event.args as { step: number }).step);
    expect(retryingSteps).toEqual([2]);
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 1' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
    expect(ctx.contextData().history).toContainEqual(
      expect.objectContaining({
        role: 'user',
        content: [{ type: 'text', text: 'continue 2' }],
        origin: { kind: 'system_trigger', name: 'stop_hook' },
      }),
    );
  });

  it('raises the abort-listener ceiling on the step signal for parallel tool bursts', async () => {
    profile.update({ activeToolNames: [] });
    let observed = 0;
    loop.hooks.onDidFinishStep.register(
      'test-step-signal-listener-ceiling',
      async (hookCtx, next) => {
        observed = getMaxListeners(hookCtx.signal);
        await next();
      },
    );

    ctx.mockNextResponse({ type: 'text', text: 'answer' });

    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
    await ctx.untilTurnEnd();

    expect(observed).toBe(64);
  });

  it('ends the turn when an afterStep hook sets stopTurn even though the model requested tool calls', async () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };
    const lookupTool: ExecutableTool<{ query: string }> = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
        },
        required: ['query'],
        additionalProperties: false,
      },
      resolveExecution: () => ({
        approvalRule: 'Lookup',
        execute: async () => ({ output: 'lookup-result' }),
      }),
    };
    profile.update({ activeToolNames: ['Lookup'] });
    ctx.get(IAgentToolRegistryService).register(lookupTool);

    loop.hooks.onDidFinishStep.register('test-stop-turn', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    ctx.mockNextResponse({ type: 'text', text: 'This step should not run.' });

    const { turn } = submitTurn(loop, 'Look up moon');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('lets stopTurn take precedence over a queued continuation request', async () => {
    profile.update({ activeToolNames: [] });

    loop.hooks.onDidFinishStep.register('test-continue-like-stop-hook', async (hookCtx, next) => {
      loop.notify();
      await next();
    });
    loop.hooks.onDidFinishStep.register('test-hard-stop', async (hookCtx, next) => {
      hookCtx.stopTurn = true;
      await next();
    });

    ctx.mockNextResponse({ type: 'text', text: 'First answer.' });
    ctx.mockNextResponse({ type: 'text', text: 'This continuation should not run.' });

    const { turn } = submitTurn(loop, 'hello');
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
    });
  });

  it('carries a tool stopTurnReason into the completed turn result and turn.ended', async () => {
    const stopCall: ToolCall = {
      type: 'function',
      id: 'call_stop',
      name: 'Stopper',
      arguments: '{}',
    };
    const stopperTool: ExecutableTool<Record<string, never>> = {
      name: 'Stopper',
      description: 'Stops the turn with a reason.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      resolveExecution: () => ({
        approvalRule: 'Stopper',
        execute: async () => ({ output: 'stopped', stopTurn: true, stopTurnReason: 'demo_reason' }),
      }),
    };
    profile.update({ activeToolNames: ['Stopper'] });
    ctx.get(IAgentToolRegistryService).register(stopperTool);

    ctx.mockNextResponse({ type: 'text', text: 'Stopping.' }, stopCall);
    ctx.mockNextResponse({ type: 'text', text: 'This step should not run.' });

    const { turn } = submitTurn(loop, 'stop');
    await ctx.untilApproval(true);
    await ctx.untilTurnEnd();

    expect(ctx.llmCalls).toHaveLength(1);
    await expect(turn!.result).resolves.toEqual({
      type: 'completed',
      steps: 1,
      truncated: false,
      stopReason: 'demo_reason',
    });
    const turnEnded = ctx.allEvents.find(
      (event) => event.type === '[rpc]' && event.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'completed', stopReason: 'demo_reason' });
    const record = (await ctx.persistedWireRecords()).find((entry) => entry.type === 'turn.ended');
    expect(record).toMatchObject({ turnId: 0, reason: 'completed', stopReason: 'demo_reason' });
  });

  it('queues consecutive nextTurn requests in FIFO order without overlapping turns', async () => {
    const events: string[] = [];
    const subscription = ctx.get(IEventBus).subscribe((event) => {
      if (event instanceof TurnStarted || event instanceof TurnEnded) {
        events.push(`${event.type}:${event.turnId}`);
      }
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'two' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = submitTurn(loop, 'first').turn;
    const second = submitTurn(loop, 'second').turn;
    const third = submitTurn(loop, 'third').turn;
    loop.notify();

    await Promise.all([first.result, second.result, third.result]);
    subscription.dispose();

    await expect(first.result).resolves.toMatchObject({ type: 'completed' });
    await expect(second.result).resolves.toMatchObject({ type: 'completed' });
    await expect(third.result).resolves.toMatchObject({ type: 'completed' });
    expect(events).toEqual([
      'turn.started:0',
      'turn.ended:0',
      'turn.started:1',
      'turn.ended:1',
      'turn.started:2',
      'turn.ended:2',
    ]);
    expect(ctx.llmCalls).toHaveLength(3);
  });

  it('takes a non-pausing history snapshot while a turn runs to natural completion', async () => {
    let started!: () => void;
    const activeStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const canFinish = new Promise<void>((resolve) => {
      release = resolve;
    });
    const hook = loop.hooks.onWillBeginStep.register('test-quiescence', async (_hookCtx, next) => {
      started();
      await canFinish;
      await next();
    });

    const active = submitTurn(loop, 'active').turn;
    await activeStarted;

    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    const snapshot = loop.tryAcquireHistorySnapshot();
    expect(snapshot).toBeDefined();
    expect(loop.tryAcquireHistorySnapshot()).toBeUndefined();
    expect(loop.snapshot().paused).toBe(false);
    expect(active.signal.aborted).toBe(false);

    ctx.mockNextResponse({ type: 'text', text: 'completed normally' });
    release();
    await expect(active.result).resolves.toMatchObject({ type: 'completed' });
    expect(loop.tryAcquireQuiescence()).toBeUndefined();

    snapshot?.dispose();
    const quiescence = loop.tryAcquireQuiescence();
    expect(quiescence).toBeDefined();
    quiescence?.dispose();
    hook.dispose();
  });

  it('holds new admissions until an idle quiescence lease is released', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    expect(loop.tryAcquireQuiescence()).toBeUndefined();
    const held = submitTurn(loop, 'held').turn;
    let started = false;
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, () => {
      started = true;
    });

    await Promise.resolve();
    expect(started).toBe(false);
    expect(held.state).toBe('queued');
    expect(loop.snapshot()).toMatchObject({ state: 'idle', hasPendingRequests: true });

    ctx.mockNextResponse({ type: 'text', text: 'after undo' });
    lease?.dispose();
    await expect(held.result).resolves.toMatchObject({ type: 'completed' });
    subscription.dispose();

    const parked = createTestAgent(sessionService(IAgentLifecycleService, parkedLifecycleStub()));
    try {
      const parkedLoop = parked.get(IAgentLoopService);
      const early = submitTurn(parkedLoop, 'early').turn;
      expect(parkedLoop.snapshot()).toMatchObject({ state: 'idle', hasPendingRequests: true });
      expect(parked.llmCalls).toHaveLength(0);

      const earlyQueueId = parkedLoop.snapshot().queue[0]!.meta!.promptId!;
      expect(parkedLoop.cancel({ promptId: earlyQueueId }, new Error('not wanted'))).toBe(true);
      await expect(early.result).resolves.toMatchObject({ type: 'cancelled' });

      const real = submitTurn(parkedLoop, 'real').turn;
      let nudgeConsumed = 0;
      parkedLoop.notify({
        message: { role: 'user', content: [{ type: 'text', text: 'nudge text' }], toolCalls: [] },
        onConsume: () => {
          nudgeConsumed += 1;
        },
      });
      parked.mockNextResponse({ type: 'text', text: 'real answer' });
      const parkedRef = attachParkedEngine(parkedLoop);
      try {
        await expect(real.result).resolves.toMatchObject({ type: 'completed' });
        expect(nudgeConsumed).toBe(1);
        expect(parked.llmCalls).toHaveLength(1);
        expect(parked.contextData().history).toContainEqual(
          expect.objectContaining({
            content: [{ type: 'text', text: 'nudge text' }],
          }),
        );
      } finally {
        parkedRef.stop();
      }
    } finally {
      await parked.dispose();
    }
  });

  it('can abort an admission while quiescence holds it', async () => {
    const lease = loop.tryAcquireQuiescence();
    expect(lease).toBeDefined();
    const held = submitTurn(loop, 'held').turn;
    const resumed = submitTurn(loop, 'resumed').turn;

    expect(held.cancel()).toBe(true);
    await expect(held.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    expect(loop.snapshot().hasPendingRequests).toBe(true);

    ctx.mockNextResponse({ type: 'text', text: 'resumed answer' });
    lease?.dispose();
    await expect(resumed.result).resolves.toMatchObject({ type: 'completed', steps: 1 });
    expect(loop.snapshot().hasPendingRequests).toBe(false);
    expect(loop.snapshot().state).toBe('idle');
  });

  it('cancels an in-flight turn while its queued turn continues afterwards', async () => {
    let releaseRunning!: () => void;
    const running = new Promise<void>((resolve) => {
      releaseRunning = resolve;
    });
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    let armed = true;
    loop.hooks.onWillBeginStep.register('test-turn-cancel-mid-step', async (hookCtx, next) => {
      if (armed) {
        armed = false;
        stepStarted();
        await Promise.race([
          running,
          new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), {
              once: true,
            });
          }),
        ]);
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'after cancellation' });

    const turn = submitTurn(loop, 'start').turn;
    const queued = submitTurn(loop, 'next').turn;
    await started;

    expect(turn.cancel(new Error('skip this turn'))).toBe(true);
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    releaseRunning();
    await expect(queued.result).resolves.toMatchObject({ type: 'completed', steps: 1 });

    expect(queued.state).toBe('completed');
    expect(ctx.llmCalls).toHaveLength(1);
  });

  it('disposes active and queued turns with all turns settled and never pumps again', async () => {
    let stepStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      stepStarted = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-dispose-loop', async (hookCtx, next) => {
      stepStarted();
      await new Promise<void>((_, reject) => {
        hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), {
          once: true,
        });
      });
      await next();
    });

    const active = submitTurn(loop, 'active').turn;
    const queued = submitTurn(loop, 'queued').turn;
    const queuedExtra = submitTurn(loop, 'queued-extra').turn;
    await started;

    (loop as IAgentLoopService & { dispose(): void }).dispose();

    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await expect(queuedExtra.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    expect(active.state).toBe('cancelled');
    expect(queued.state).toBe('cancelled');
    expect(ctx.llmCalls).toHaveLength(0);
    expect(() => submitTurn(loop, 'rejected')).toThrow();
  });

  it('cancels a queued turn without starting or materializing its initial request', async () => {
    const started: number[] = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      started.push(event.turnId);
    });
    ctx.mockNextResponse({ type: 'text', text: 'one' });
    ctx.mockNextResponse({ type: 'text', text: 'three' });

    const first = submitTurn(loop, 'first').turn;
    const cancelledTurn = submitTurn(loop, 'cancelled').turn;
    const third = submitTurn(loop, 'third').turn;

    expect(cancelledTurn.cancel()).toBe(true);
    await expect(cancelledTurn.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await Promise.all([first.result, third.result]);
    subscription.dispose();

    expect(started).toEqual([0, 1]);
    expect(ctx.contextData().history).not.toContainEqual(
      expect.objectContaining({ content: [{ type: 'text', text: 'cancelled' }] }),
    );
  });

  it('omits the turn.started prompt for system-triggered turns', async () => {
    const prompts: Array<string | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      prompts.push(event.prompt);
    });
    ctx.mockNextResponse({ type: 'text', text: 'continued' });
    ctx.mockNextResponse({ type: 'text', text: 'hi there' });

    const system = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'continue the goal' }] },
      meta: { origin: { kind: 'system_trigger', name: 'goal_continuation' } as PromptOrigin },
    }).turn;
    await system.result;
    const user = submitTurn(loop, 'hi').turn;
    await user.result;
    subscription.dispose();

    expect(prompts).toEqual([undefined, 'hi']);
  });

  it('carries the turn.started prompt for subagent system triggers', async () => {
    const prompts: Array<string | undefined> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      prompts.push(event.prompt);
    });
    ctx.mockNextResponse({ type: 'text', text: 'scanned' });

    const subagent = submitPromptTurn(loop, {
      message: { role: 'user', content: [{ type: 'text', text: 'scan the repo' }] },
      meta: { origin: { kind: 'system_trigger', name: 'subagent' } as PromptOrigin },
    }).turn;
    await subagent.result;
    subscription.dispose();

    expect(prompts).toEqual(['scan the repo']);
  });

  it('carries kimi-file prompt attachments on turn.started, falling back to the URL file id', async () => {
    const payloads: Array<TurnStarted['promptAttachments']> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = submitPromptTurn(loop, {
      message: {
        role: 'user',
        content: [
          {
            type: 'image_url',
            imageUrl: { url: 'kimi-file://file_1', id: 'file_1', name: 'photo.png' },
          },
          {
            type: 'video_url',
            videoUrl: { url: 'kimi-file://file_2', id: 'file_2', name: 'clip.mp4' },
          },
          { type: 'image_url', imageUrl: { url: 'kimi-file://file_3' } },
          { type: 'image_url', imageUrl: { url: 'kimi-file://file_4', id: 'other' } },
          { type: 'image_url', imageUrl: { url: 'https://example.com/no-id.png' } },
          { type: 'image_url', imageUrl: { url: 'ms://provider-blob', id: 'prov_1' } },
          { type: 'text', text: 'look' },
        ],
      },
      meta: { origin: { kind: 'user' } },
    }).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        { kind: 'image', fileId: 'file_1', name: 'photo.png' },
        { kind: 'video', fileId: 'file_2', name: 'clip.mp4' },
        { kind: 'image', fileId: 'file_3' },
      ],
    ]);
  });

  it('carries origin file attachments on turn.started promptAttachments', async () => {
    const payloads: Array<TurnStarted['promptAttachments']> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = submitPromptTurn(loop, {
      message: {
        role: 'user',
        content: [
          { type: 'image_url', imageUrl: { url: 'kimi-file://file_1', id: 'file_1' } },
          { type: 'text', text: 'summarize' },
        ],
      },
      meta: {
        origin: {
          kind: 'user',
          attachments: [
            {
              name: 'report.pdf',
              mediaType: 'application/pdf',
              size: 42,
              path: '/data/report.pdf',
            },
          ],
        } as PromptOrigin,
      },
    }).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        { kind: 'image', fileId: 'file_1' },
        {
          kind: 'file',
          name: 'report.pdf',
          mediaType: 'application/pdf',
          size: 42,
          path: '/data/report.pdf',
        },
      ],
    ]);
  });

  it('carries skill activation file attachments on turn.started promptAttachments', async () => {
    const payloads: Array<TurnStarted['promptAttachments']> = [];
    const subscription = ctx.get(IEventBus).subscribe(TurnStarted, (event) => {
      payloads.push(event.promptAttachments);
    });
    ctx.mockNextResponse({ type: 'text', text: 'seen' });

    const turn = submitPromptTurn(loop, {
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'User activated the skill "check".' }],
      },
      meta: {
        origin: {
          kind: 'skill_activation',
          activationId: 'act_1',
          skillName: 'check',
          trigger: 'user-slash',
          attachments: [
            {
              name: 'note.txt',
              mediaType: 'text/plain',
              size: 21,
              path: '/data/note.txt',
            },
          ],
        } as PromptOrigin,
      },
    }).turn;
    await turn.result;
    subscription.dispose();

    expect(payloads).toEqual([
      [
        {
          kind: 'file',
          name: 'note.txt',
          mediaType: 'text/plain',
          size: 21,
          path: '/data/note.txt',
        },
      ],
    ]);
  });

  it('settles the waiter of a notification-seeded turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'seeded answer' });
    loop.notify({
      message: {
        role: 'user',
        id: 'seed-1',
        content: [{ type: 'text', text: 'wake up' }],
        toolCalls: [],
      },
    });
    await waitForAssertion(() => {
      expect(loop.promptHandle('seed-1')).toBeDefined();
    });
    await expect(loop.promptHandle('seed-1')!.completion).resolves.toMatchObject({
      state: 'completed',
    });
    await loop.settled();
  });
});

describe('turn telemetry', () => {
  it('emits turn_started and turn_ended with mode and protocol on completion', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'text', text: 'hi' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: {
          turn_id: 0,
          agent_id: 'main',
          mode: 'agent',
          model: 'mock-model',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
          enabled_plugins: '',
        },
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          duration_ms: expect.any(Number),
          mode: 'agent',
          provider_type: 'kimi',
          protocol: 'openai',
          thinking_effort: 'off',
        }),
      });
      expect(records.some((record) => record.event === 'turn_interrupted')).toBe(false);
    } finally {
      await local.dispose();
    }
  });

  it('reports enabled plugins on turn_started and turn_ended', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent(
      { telemetry: recordingTelemetry(records) },
      appService(
        IPluginService,
        stubPluginService({ sessionStarts: [], enabledPluginIds: ['alpha', 'zeta'] }),
      ),
    );
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextResponse({ type: 'text', text: 'hi' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_started',
        properties: expect.objectContaining({
          turn_id: 0,
          enabled_plugins: 'alpha,zeta',
        }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          enabled_plugins: 'alpha,zeta',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('keeps turn telemetry aligned with the request config across pre-step changes', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      const localProfile = local.get(IAgentProfileService);
      local.configure({
        modelCapabilities: {
          image_in: false,
          video_in: false,
          audio_in: false,
          thinking: true,
          tool_use: true,
          max_context_tokens: 1_000_000,
        },
      });
      localProfile.update({ activeToolNames: [] });
      localProfile.setThinking('on');
      localLoop.hooks.onWillBeginStep.register('test-change-thinking', async (_ctx, next) => {
        localProfile.setThinking('off');
        await next();
      });
      local.mockNextResponse({ type: 'text', text: 'hi' });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      const request = local.allEvents.find(
        (event) => event.type === '[wire]' && event.event === 'llm.request',
      );
      expect(request?.args).toMatchObject({ thinkingEffort: 'on' });
      expect(records).toContainEqual({
        event: 'turn_started',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({ turn_id: 0, thinking_effort: 'on' }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('attaches the latest request trace id to turn_ended', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        traceId: 'trace-turn-1',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'completed',
          trace_id: 'trace-turn-1',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('clears the ambient trace id when the turn ends', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        traceId: 'trace-turn-clear',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(local.get(ITelemetryService).getContext()['trace_id']).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('does not reuse the previous step trace when a step hook fails before a request', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const localLoop = local.get(IAgentLoopService);
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      localLoop.hooks.onDidFinishStep.register(
        'test-continue-after-first-step',
        async (hookCtx, next) => {
          if (hookCtx.step === 1) {
            localLoop.notify();
            return;
          }
          await next();
        },
      );
      localLoop.hooks.onWillBeginStep.register(
        'test-fail-before-second-request',
        async (hookCtx, next) => {
          if (hookCtx.step === 2) throw new Error('before step failed');
          await next();
        },
      );
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first' }],
        traceId: 'trace-step-1',
      });

      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(local.llmCalls).toHaveLength(1);
      expect(
        records.find((record) => record.event === 'turn_interrupted')?.properties?.['trace_id'],
      ).toBeUndefined();
      expect(
        records.find((record) => record.event === 'turn_ended')?.properties?.['trace_id'],
      ).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('emits turn_interrupted with interrupt_reason filtered and turn_ended failed', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'blocked' }],
        finishReason: 'filtered',
        traceId: 'trace-turn-2',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      expect(records).toContainEqual({
        event: 'turn_interrupted',
        properties: expect.objectContaining({
          turn_id: 0,
          at_step: 1,
          mode: 'agent',
          interrupt_reason: 'filtered',
          provider_type: 'kimi',
          protocol: 'openai',
          trace_id: 'trace-turn-2',
        }),
      });
      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'failed',
          mode: 'agent',
          error_type: 'provider.filtered',
          trace_id: 'trace-turn-2',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it('carries the last step trace id on the turn.ended event payload', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'hi' }],
        traceId: 'trace-payload-completed',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.traceId).toBe('trace-payload-completed');
      const record = (await local.persistedWireRecords()).find(
        (entry) => entry.type === 'turn.ended',
      );
      expect(record).toMatchObject({ traceId: 'trace-payload-completed' });
    } finally {
      await local.dispose();
    }
  });

  it('carries the in-flight trace id on the turn.ended payload when the turn fails', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'blocked' }],
        finishReason: 'filtered',
        traceId: 'trace-payload-failed',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.reason).toBe('failed');
      expect(ended[0]!.traceId).toBe('trace-payload-failed');
    } finally {
      await local.dispose();
    }
  });

  it('carries the in-flight trace id on the turn.ended payload when the turn is cancelled', async () => {
    let requestStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const generate: GenerateFn = {
      async generate(_config, _content, control) {
        control.onEvent?.({
          type: 'llm.streaming.headers',
          headers: { 'x-trace-id': 'trace-payload-cancelled' },
        });
        requestStarted();
        await new Promise<void>((_, reject) => {
          control.signal.addEventListener('abort', () => reject(control.signal.reason as unknown), {
            once: true,
          });
        });
      },
    };
    const local = createTestAgent({ generate });
    try {
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      const prompt = local.rpc
        .prompt({ input: [{ type: 'text', text: 'Hello' }] })
        .catch(() => undefined);
      await started;
      const turnEnd = local.untilTurnEnd();
      local.get(IAgentLoopService).cancel({ turnId: 0 }, new Error('stop'));
      await turnEnd;
      await prompt;
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.reason).toBe('cancelled');
      expect(ended[0]!.traceId).toBe('trace-payload-cancelled');
    } finally {
      await local.dispose();
    }
  });

  it('omits the trace id on the turn.ended payload when the turn saw none', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'hi' }] });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(1);
      expect(ended[0]!.traceId).toBeUndefined();
      const record = (await local.persistedWireRecords()).find(
        (entry) => entry.type === 'turn.ended',
      );
      expect(record).not.toHaveProperty('traceId');
    } finally {
      await local.dispose();
    }
  });

  it('does not leak a compaction request trace id into the turn.ended payload', async () => {
    const local = createTestAgent();
    try {
      local.get(IAgentProfileService).update({ activeToolNames: [] });
      const ended: TurnEnded[] = [];
      const subscription = local.get(IEventBus).subscribe((event) => {
        if (event instanceof TurnEnded) ended.push(event);
      });
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'first' }],
        traceId: 'trace-turn-one',
      });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
      await local.untilTurnEnd();

      local.appendExchange(2, 'old user two', 'old assistant two', 80);
      local.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'Compacted summary.' }],
        traceId: 'trace-compaction',
      });
      expect(local.get(IAgentFullCompactionService).begin({ source: 'manual' })).toBe(true);
      await local.get(IAgentFullCompactionService).compacting?.promise;

      local.mockNextProviderResponse({ parts: [{ type: 'text', text: 'second' }] });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'Again' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(ended).toHaveLength(2);
      expect(ended[0]!.traceId).toBe('trace-turn-one');
      expect(ended[1]!.traceId).toBeUndefined();
    } finally {
      await local.dispose();
    }
  });

  it('emits turn_ended with error_type for an uncoded failure', async () => {
    const records: TelemetryRecord[] = [];
    const local = createTestAgent({ telemetry: recordingTelemetry(records) });
    try {
      const workTool: ExecutableTool = {
        name: 'Work',
        description: 'Pretend to work.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        resolveExecution: () => ({
          approvalRule: 'Work',
          execute: async () => ({ output: 'should never run' }),
        }),
      };
      local.get(IAgentToolRegistryService).register(workTool);
      local.get(IAgentProfileService).update({ activeToolNames: ['Work'] });
      const subscription = local.get(IAgentToolExecutorService).onBeforeExecuteTool(() => {
        throw new Error('beforeExecute blew up');
      });
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
      );
      await local.rpc.prompt({ input: [{ type: 'text', text: 'use the tool' }] });
      await local.untilTurnEnd();
      subscription.dispose();

      expect(records).toContainEqual({
        event: 'turn_ended',
        properties: expect.objectContaining({
          turn_id: 0,
          reason: 'failed',
          error_type: 'internal',
        }),
      });
    } finally {
      await local.dispose();
    }
  });

  it.each([
    ['user_cancelled', () => userCancellationReason()],
    ['aborted', () => new Error('stop')],
  ] as const)(
    'emits turn_interrupted with interrupt_reason %s on cancellation',
    async (expected, makeReason) => {
      const records: TelemetryRecord[] = [];
      const local = createTestAgent({ telemetry: recordingTelemetry(records) });
      try {
        const localLoop = local.get(IAgentLoopService);
        let stepStarted!: () => void;
        const started = new Promise<void>((resolve) => {
          stepStarted = resolve;
        });
        localLoop.hooks.onWillBeginStep.register('test-hang', async (hookCtx, next) => {
          stepStarted();
          await new Promise<void>((_, reject) => {
            hookCtx.signal.addEventListener('abort', () => reject(hookCtx.signal.reason), {
              once: true,
            });
          });
          await next();
        });

        const turn = submitTurn(localLoop, 'hang').turn;
        await started;
        localLoop.cancel({ turnId: turn.id }, makeReason());
        await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

        expect(records).toContainEqual({
          event: 'turn_interrupted',
          properties: expect.objectContaining({
            turn_id: 0,
            interrupt_reason: expected,
            mode: 'agent',
          }),
        });
        expect(records).toContainEqual({
          event: 'turn_ended',
          properties: expect.objectContaining({ reason: 'cancelled' }),
        });
      } finally {
        await local.dispose();
      }
    },
  );
});

describe('interruption reminder', () => {
  let ctx: TestAgentContext;
  let loop: IAgentLoopService;

  beforeEach(async () => {
    ctx = createTestAgent();
    loop = ctx.get(IAgentLoopService);
    await ctx.restorePersisted();
  });

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
    }
  });

  function cancelOnFirstDelta(): IDisposable {
    return ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel();
    });
  }

  function remindersIn(target: TestAgentContext): ContextMessage[] {
    return target
      .contextData()
      .history.filter(
        (message) =>
          message.origin?.kind === 'injection' && message.origin.variant === 'interruption',
      );
  }

  function interruptionReminders(): ContextMessage[] {
    return remindersIn(ctx);
  }

  function initialLoadableToolsMessage() {
    return expect.objectContaining({
      role: 'user',
      origin: expect.objectContaining({ kind: 'injection', variant: 'loadable-tools' }),
    });
  }

  function contentPartRecordsIn(target: TestAgentContext): number {
    return target.allEvents.filter(
      (entry) =>
        entry.type === '[wire]' &&
        entry.event === 'context.append_loop_event' &&
        (entry.args as { event?: { type?: string } }).event?.type === 'content.part',
    ).length;
  }

  it('preserves the partial stream and appends one reminder at the cancellation event point', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history.slice(0, 3)).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Hello' }] }),
      initialLoadableToolsMessage(),
      {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial answer' }],
        toolCalls: [],
        partial: true,
      },
    ]);
    expect(interruptionReminders()).toHaveLength(1);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({
      turnId: 0,
      target: 'active',
      reason: 'user_cancelled',
    });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({
      reason: 'cancelled',
      interruptReason: 'user_cancelled',
    });
    expect(contentPartRecordsIn(ctx)).toBe(1);

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(interruptionReminders()).toHaveLength(1);
    expect(interruptionReminders()[0]!.content).toEqual([
      {
        type: 'text',
        text: "<system-reminder>\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.\n</system-reminder>",
      },
    ]);
    expect(ctx.contextData().history.indexOf(interruptionReminders()[0]!)).toBe(3);
  });

  it('writes one active cancellation when cancel repeats before the turn settles', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const results: boolean[] = [];
    let cancelled = false;
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      if (cancelled) return;
      cancelled = true;
      results.push(loop.cancel(), loop.cancel());
    });
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(results).toEqual([true, true]);
    expect(
      ctx.allEvents.filter((entry) => entry.type === '[wire]' && entry.event === 'turn.cancel'),
    ).toHaveLength(1);
    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('preserves the partial stream but appends no reminder on programmatic abort', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel(undefined, new Error('stop'));
    });
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'partial answer' }],
      toolCalls: [],
      partial: true,
    });
    expect(interruptionReminders()).toHaveLength(0);

    const cancelRecord = ctx.allEvents.find(
      (entry) => entry.type === '[wire]' && entry.event === 'turn.cancel',
    );
    expect(cancelRecord?.args).toMatchObject({ target: 'active', reason: 'aborted' });
    const turnEnded = ctx.allEvents.find(
      (entry) => entry.type === '[rpc]' && entry.event === 'turn.ended',
    );
    expect(turnEnded?.args).toMatchObject({ reason: 'cancelled', interruptReason: 'aborted' });
  });

  it('does not stack a second reminder without an intervening message', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx
      .get(IEventBus)
      .publish(
        new TurnEnded({
          agentId: 'main',
          turnId: 99,
          reason: 'cancelled',
          interruptReason: 'user_cancelled',
        }),
      );

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('appends no reminder when a queued turn is user-cancelled before starting', async () => {
    let release!: () => void;
    let armed = true;
    let signalEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalEntered = resolve;
    });
    loop.hooks.onWillBeginStep.register('test-hang-queued-cancel', async (hookCtx, next) => {
      if (armed) {
        armed = false;
        signalEntered();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      await next();
    });
    ctx.mockNextResponse({ type: 'text', text: 'unreached' });

    const active = submitTurn(loop, 'active').turn;
    const queued = submitTurn(loop, 'queued').turn;
    expect(queued.cancel()).toBe(true);
    await expect(queued.result).resolves.toMatchObject({ type: 'cancelled', steps: 0 });
    await entered;
    release();
    loop.cancel({ turnId: active.id });
    await expect(active.result).resolves.toMatchObject({ type: 'cancelled' });

    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('sends the partial output and reminder in the next atomic step', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' }, { type: 'text', text: ' more' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    ctx.llmInputs();

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    expect(renderSnapshot(ctx.lastLlmInput())).toMatchInlineSnapshot(`
      "messages:
        <last>
        assistant: text "partial answer"
        user: text "<system-reminder>\\nThe previous turn was interrupted by the user before completion; any partial output shown above is incomplete. The user's next message continues the conversation.\\n</system-reminder>"
        user: text "Next""
    `);
  });

  it('undo removes the event-point interruption with its cancelled turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([initialLoadableToolsMessage()]);
    await ctx.expectResumeMatches();

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(0);
  });

  it('keeps an interruption reminder when undo only removes a later turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const subscription = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();
    subscription.dispose();
    const interruptedHistory = ctx.contextData().history;

    ctx.mockNextResponse({ type: 'text', text: 'second answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual(interruptedHistory);
    expect(interruptionReminders()).toHaveLength(1);
    await ctx.expectResumeMatches();

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([initialLoadableToolsMessage()]);
  });

  it('undo removes a cancelled retry reminder with its preceding user prompt', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'first answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Hello' }] });
    await ctx.untilTurnEnd();

    ctx.mockNextResponse({ type: 'text', text: 'partial retry' });
    const subscription = cancelOnFirstDelta();
    const retry = submitPromptTurn(loop, {
      message: { role: 'user', content: [] },
      meta: { origin: { kind: 'retry' } },
    }).turn;
    await expect(retry.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    await ctx.undoHistory(1);

    expect(ctx.contextData().history).toEqual([initialLoadableToolsMessage()]);
  });

  it('drops unsigned thinking but keeps signed thinking on user cancel', async () => {
    ctx.mockNextResponse({ type: 'think', think: 'pondering' }, { type: 'text', text: 'answer' });
    const subscription = ctx.get(IEventBus).subscribe(ThinkingDelta, () => {
      loop.cancel();
    });
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    const thinkParts = ctx
      .contextData()
      .history.flatMap((message) => message.content)
      .filter((part) => part.type === 'think');
    expect(thinkParts).toEqual([]);
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse(
      { type: 'think', think: 'seg', encrypted: 'sig' },
      { type: 'text', text: 'partial answer' },
    );
    const second = ctx.get(IEventBus).subscribe(AssistantDelta, () => {
      loop.cancel();
    });
    const secondTurn = submitTurn(loop, 'Again').turn;
    await expect(secondTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    second.dispose();

    expect(ctx.contextData().history).toContainEqual({
      role: 'assistant',
      content: [
        { type: 'think', think: 'seg', encrypted: 'sig' },
        { type: 'text', text: 'partial answer' },
      ],
      toolCalls: [],
      partial: true,
    });
  });

  it('records no partial content when the stream only produced whitespace', async () => {
    ctx.mockNextResponse({ type: 'text', text: '  ' }, { type: 'text', text: 'answer' });
    const subscription = cancelOnFirstDelta();
    const turn = submitTurn(loop, 'Hello').turn;
    await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });
    subscription.dispose();

    expect(contentPartRecordsIn(ctx)).toBe(0);
    expect(ctx.contextData().history.slice(0, 3)).toEqual([
      expect.objectContaining({ role: 'user' }),
      initialLoadableToolsMessage(),
      { role: 'assistant', content: [], toolCalls: [], partial: true },
    ]);
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('does not stack a second reminder around a vacuous retry turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'partial answer' });
    const first = cancelOnFirstDelta();
    const firstTurn = submitTurn(loop, 'Hello').turn;
    await expect(firstTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    first.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'retried answer' });
    const onStepStarted = ctx.get(IEventBus).subscribe(TurnStepStarted, () => {
      loop.cancel();
    });
    const retryTurn = submitPromptTurn(loop, {
      message: { role: 'user', content: [] },
      meta: { origin: { kind: 'retry' } },
    }).turn;
    await expect(retryTurn.result).resolves.toMatchObject({ type: 'cancelled' });
    onStepStarted.dispose();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'third answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Next' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);
  });

  it('renders a new interruption reminder after an intervening completed turn', async () => {
    ctx.mockNextResponse({ type: 'text', text: 'first partial answer' });
    const first = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'first prompt' }] });
    await ctx.untilTurnEnd();
    first.dispose();

    ctx.mockNextResponse({ type: 'text', text: 'completed answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'completed prompt' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(1);

    ctx.mockNextResponse({ type: 'text', text: 'second partial answer' });
    const second = cancelOnFirstDelta();
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'second prompt' }] });
    await ctx.untilTurnEnd();
    second.dispose();

    ctx.mockNextResponse({ type: 'text', text: 'final answer' });
    await ctx.rpc.prompt({ input: [{ type: 'text', text: 'final prompt' }] });
    await ctx.untilTurnEnd();
    expect(interruptionReminders()).toHaveLength(2);
  });

  it('does not duplicate recorded content when cancelled during tool execution', async () => {
    const local = createTestAgent(permissionModeServices('yolo'));
    const releaseSlowTool = deferred();
    try {
      const slowToolStarted = registerAbortableWorkTool(local, releaseSlowTool.promise);
      const localLoop = local.get(IAgentLoopService);
      local.mockNextResponse(
        { type: 'text', text: 'working' },
        { type: 'function', id: 'call-work-1', name: 'Work', arguments: '{}' },
      );
      local.mockNextResponse(
        { type: 'text', text: 'still working' },
        { type: 'function', id: 'call-work-2', name: 'Work', arguments: '{}' },
      );
      const turn = submitTurn(localLoop, 'do work').turn;
      await slowToolStarted.promise;
      localLoop.cancel({ turnId: turn.id });
      localLoop.cancel({ turnId: turn.id });
      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled' });

      expect(contentPartRecordsIn(local)).toBe(2);
      expect(remindersIn(local)).toHaveLength(1);

      const loopEvents = local.allEvents
        .filter((entry) => entry.type === '[wire]' && entry.event === 'context.append_loop_event')
        .map((entry) => (entry.args as { event: LoopRecordedEvent }).event);
      const toolCalls = loopEvents.filter((event) => event.type === 'tool.call');
      const toolResults = loopEvents.filter((event) => event.type === 'tool.result');
      for (const call of toolCalls) {
        expect(
          toolResults.some(
            (result) => result.toolCallId === call.toolCallId && result.parentUuid === call.uuid,
          ),
        ).toBe(true);
      }
      expect(toolResults.filter((event) => event.toolCallId === 'call-work-2')).toEqual([
        expect.objectContaining({
          result: {
            output:
              'The user manually interrupted "Work" (and anything else running at the same time). This was a deliberate user action, not a system error, timeout, or capacity limit. Do not retry automatically or guess at the cause — wait for the user\'s next instruction.',
            isError: true,
          },
        }),
      ]);

      local.mockNextResponse({ type: 'text', text: 'follow-up answer' });
      await local.rpc.prompt({ input: [{ type: 'text', text: 'again' }] });
      await local.untilTurnEnd();

      const history = local.contextData().history;
      expect(remindersIn(local)).toHaveLength(1);
      const reminderIndex = history.indexOf(remindersIn(local)[0]!);
      expect(history.slice(0, reminderIndex).some((message) => message.role === 'tool')).toBe(true);
      expect(history[reminderIndex + 1]).toMatchObject({
        role: 'user',
        content: [{ type: 'text', text: 'again' }],
      });

      await local.expectResumeMatches();
    } finally {
      releaseSlowTool.resolve();
      await local.dispose();
    }
  });
});

describe('step timing split propagation', () => {
  it('carries the split from the llmRequester timing event to the turn.step.completed protocol event', async () => {
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, createTimingRequester()));
    try {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'hello' }] });
      await ctx.untilTurnEnd();

      const stepCompleted = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'turn.step.completed',
      );
      expect(stepCompleted?.args).toMatchObject({
        llmFirstTokenLatencyMs: 100,
        llmStreamDurationMs: 200,
        llmRequestBuildMs: 30,
        llmServerFirstTokenMs: 70,
        llmServerDecodeMs: 150,
        llmClientConsumeMs: 50,
        llmClientBlockedMs: 20,
      });
    } finally {
      await ctx.dispose();
    }
  });
});

describe('aborted step tool execution', () => {
  it('accounts model usage when the step is aborted during tool execution', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    await ctx.restorePersisted();
    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const goals = ctx.get(IAgentGoalService);
      await goals.createGoal({ objective: 'finish the task' });
      await goals.setBudgetLimits({ budgetLimits: { tokenBudget: 167 } });
      ctx
        .get(IEventBus)
        .publish(new TurnStarted({ agentId: 'main', turnId: 1, origin: { kind: 'user' } }));

      const loopService = ctx.get(IAgentLoopService);
      const { turn } = submitTurn(loopService, 'work');
      await slowToolStarted.promise;
      turn.cancel(new Error('cancelled by test'));

      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(ctx.usage.status()).toMatchObject({
        total: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
        currentTurn: {
          inputOther: 107,
          output: 61,
          inputCacheRead: 0,
          inputCacheCreation: 0,
        },
      });
      expect(goals.getGoal().goal).toMatchObject({
        status: 'blocked',
        tokensUsed: 168,
        budget: { tokenBudgetReached: true },
      });
    } finally {
      await ctx.dispose();
    }
  });

  it('includes the programmatic abort reason when a tool execution is interrupted', async () => {
    const ctx = createTestAgent(
      { generate: createAbortedStepGenerate() },
      permissionModeServices('yolo'),
    );
    let interrupted: { readonly reason: string; readonly message?: string } | undefined;
    const subscription = ctx.get(IEventBus).subscribe(TurnStepInterrupted, (event) => {
      interrupted = event;
    });

    try {
      const slowToolStarted = registerAbortableWorkTool(ctx);
      const loopService = ctx.get(IAgentLoopService);
      const { turn } = submitTurn(loopService, 'work');
      await slowToolStarted.promise;
      turn.cancel(new Error('Tool execution timed out'));

      await expect(turn.result).resolves.toMatchObject({ type: 'cancelled', steps: 2 });
      expect(interrupted).toMatchObject({
        reason: 'aborted',
        message: 'Tool execution timed out',
      });
    } finally {
      subscription.dispose();
      await ctx.dispose();
    }
  });

  it('settles a message-less notification when credential resolution rejects before the first request', async () => {
    const rejectingCredentials = () => ({
      resolve: () => Promise.reject(new Error('OAuth login required')),
    });
    const requester: IAgentLLMRequesterService = {
      _serviceBrand: undefined,
      prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
      currentCredentialProvider: rejectingCredentials,
      credentialProviderForTurn: rejectingCredentials,
      lastTurnRequest: () => undefined,
      async request() {
        throw new Error('request must not run');
      },
      start() {
        throw new Error('request must not run');
      },
    };
    const ctx = createTestAgent(agentService(IAgentLLMRequesterService, requester));
    try {
      const loopService = ctx.get(IAgentLoopService);
      const handle = loopService.notify();
      await loopService.settled();
      expect(handle.dropped).toBe(false);
    } finally {
      await ctx.dispose();
    }
  });
});

function submitTurn(loop: IAgentLoopService, text: string): { readonly turn: Turn } {
  return submitPromptTurn(loop, {
    message: { role: 'user', content: [{ type: 'text', text }] },
    meta: { origin: { kind: 'user' } },
  });
}

function parkedLifecycleStub(): IAgentLifecycleService {
  return {
    _serviceBrand: undefined,
    onDidCreate: Event.None as Event<AgentContext>,
    onDidCreateScope: Event.None as Event<AgentScopeCreatedEvent>,
    onWillClose: Event.None as Event<AgentContext>,
    onDidClose: Event.None as Event<AgentContext>,
    create: () => Promise.reject(new Error('parked lifecycle stub')),
    fork: () => Promise.reject(new Error('parked lifecycle stub')),
    get: () => undefined,
    list: () => [],
    broadcastPermissionMode: () => {},
    remove: () => Promise.resolve(),
    handleOf: () => undefined,
    adopt: (handle) => agentContextOf(handle),
  };
}

function attachParkedEngine(loop: IAgentLoopService) {
  const bundle = loop.buildAttachBundle();
  const ref = createActor(createAgentMachine({}), {
    input: {
      request: bundle.request,
      scopeFactory: () =>
        Promise.resolve({
          store: bundle.store,
          turnLogic: bundle.turnLogic,
          toolLogic: bundle.toolLogic,
          tools: bundle.tools,
          request: bundle.request,
        }),
    },
  });
  ref.start();
  loop.attachEngine(ref, bundle);
  return ref;
}

function createTimingRequester(): IAgentLLMRequesterService {
  const timing: ModelRequestTiming = {
    firstTokenLatencyMs: 100,
    streamDurationMs: 200,
    requestBuildMs: 30,
    serverFirstTokenMs: 70,
    serverDecodeMs: 150,
    clientConsumeMs: 50,
    clientBlockedMs: 20,
  };

  const requester: IAgentLLMRequesterService = {
    _serviceBrand: undefined,
    prepareTurnConfig: () => ({ thinkingEffort: 'off' }),
    currentCredentialProvider: () => undefined,
    credentialProviderForTurn: () => undefined,
    lastTurnRequest: () => undefined,
    async request(_overrides, onPart = () => {}) {
      await onPart({ type: 'text', text: 'answer' });
      return {
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'answer' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        model: 'mock-model',
        timing,
      };
    },
    start(overrides, onPart, signal) {
      return { trace: { traceId: undefined }, result: this.request(overrides, onPart, signal) };
    },
  };
  return requester;
}

function createAbortedStepGenerate(): GenerateFn {
  const usages = [
    { inputOther: 100, output: 50, inputCacheRead: 0, inputCacheCreation: 0 },
    { inputOther: 7, output: 11, inputCacheRead: 0, inputCacheCreation: 0 },
  ];
  let requestIndex = 0;

  return requesterFromGenerateFn(async () => {
    const usage = usages[requestIndex];
    if (usage === undefined) throw new Error('Unexpected model request');
    requestIndex += 1;
    return {
      id: `response-${String(requestIndex)}`,
      message: {
        role: 'assistant',
        content: [],
        toolCalls: [
          {
            type: 'function',
            id: `call-work-${String(requestIndex)}`,
            name: 'Work',
            arguments: '{}',
          },
        ],
      },
      usage,
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  });
}

function registerAbortableWorkTool(
  ctx: TestAgentContext,
  ignoreAbortGate?: Promise<void>,
): ReturnType<typeof deferred> {
  const slowToolStarted = deferred();
  let executions = 0;
  const tool: ExecutableTool = {
    name: 'Work',
    description: 'Run one fast operation and one cancellable operation.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    resolveExecution: () => ({
      approvalRule: 'Work',
      accesses: [],
      execute: async ({ signal }) => {
        executions += 1;
        if (executions === 1) return { output: 'first step complete' };
        slowToolStarted.resolve();
        if (ignoreAbortGate !== undefined) {
          await ignoreAbortGate;
          return { output: 'second step late result' };
        }
        if (!signal.aborted) {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              'abort',
              () => {
                resolve();
              },
              { once: true },
            );
          });
        }
        return { output: 'second step cancelled' };
      },
    }),
  };
  ctx.get(IAgentProfileService).update({ activeToolNames: ['Work'] });
  ctx.get(IAgentToolRegistryService).register(tool);
  return slowToolStarted;
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}
