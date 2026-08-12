/**
 * Scenario: engine `session/get_context` subagent summaries pair with `Task`
 * tool invocations on the main replay — exact by the stamped parent tool
 * call id, with a FIFO fallback for legacy records that predate the stamp.
 * Wiring: `buildSubagentResumeStates` from the SDK-local layer is used
 * directly; the reconstructed agents/metadata feed the replay adapter.
 * Run: pnpm exec vitest run --config apps/vscode/vitest.config.ts test/subagent-resume.test.ts
 */

import type {
  AgentReplayRecord,
  ContentPart,
  ResumedAgentState,
  SubagentSummary,
} from "../src/sdk-local/types";
import { describe, expect, it } from "vitest";

import { buildSubagentResumeStates } from "../src/sdk-local/session";

type ReplayMessage = NonNullable<AgentReplayRecord["message"]>;

function message(
  role: ReplayMessage["role"],
  content: ContentPart[],
  options: {
    readonly toolCalls?: ReplayMessage["toolCalls"];
    readonly toolCallId?: string;
    readonly origin?: ReplayMessage["origin"];
  } = {},
): ReplayMessage {
  return {
    role,
    content,
    toolCalls: options.toolCalls ?? [],
    toolCallId: options.toolCallId,
    origin: options.origin,
  };
}

function record(messageValue: ReplayMessage, time: number = 1): AgentReplayRecord {
  return { type: "message", message: messageValue, time };
}

/** A main replay with two `Task` invocations: task-1 → "answer one", task-2
 *  → "answer two" (call order). */
function mainReplayWithTwoTaskCalls(): AgentReplayRecord[] {
  return [
    record(message("user", [{ type: "text", text: "First" }], { origin: { kind: "user" } }), 1),
    record(message("assistant", [], {
      toolCalls: [{ id: "task-1", name: "Task", arguments: JSON.stringify({ prompt: "one" }) }],
    }), 2),
    record(message("tool", [{ type: "text", text: "answer one" }], { toolCallId: "task-1" }), 3),
    record(message("assistant", [], {
      toolCalls: [{ id: "task-2", name: "Task", arguments: JSON.stringify({ prompt: "two" }) }],
    }), 4),
    record(message("tool", [{ type: "text", text: "answer two" }], { toolCallId: "task-2" }), 5),
  ];
}

/** All text parts of a synthesized child replay. */
function replayTexts(agent: ResumedAgentState | undefined): string {
  return (agent?.replay ?? [])
    .map((record) =>
      (record.message?.content ?? [])
        .filter((part): part is Extract<ContentPart, { type: "text" }> => part.type === "text")
        .map((part) => part.text)
        .join(""),
    )
    .join("\n");
}

describe("buildSubagentResumeStates (exact parent-tool-call pairing)", () => {
  it("pairs stamped summaries with their exact Task call regardless of store order", () => {
    // Store order (sub-a first) is the reverse of the call order — only the
    // stamped parent tool call ids can pair them correctly.
    const summaries: SubagentSummary[] = [
      { agentId: "sub-a", messageCount: 2, updatedAt: "t1", parentToolCallId: "task-2" },
      { agentId: "sub-b", messageCount: 2, updatedAt: "t2", parentToolCallId: "task-1" },
    ];

    const { agents, metadata } = buildSubagentResumeStates(
      mainReplayWithTwoTaskCalls(),
      summaries,
    );

    expect(replayTexts(agents["sub-a"])).toContain("answer two");
    expect(replayTexts(agents["sub-b"])).toContain("answer one");
    // The metadata carries the stamp so the replay adapter can pair exactly.
    expect(metadata["sub-a"]).toEqual({ parentAgentId: "main", parentToolCallId: "task-2" });
    expect(metadata["sub-b"]).toEqual({ parentAgentId: "main", parentToolCallId: "task-1" });
  });

  it("falls back to FIFO pairing for unstamped legacy summaries", () => {
    const summaries: SubagentSummary[] = [
      { agentId: "sub-a", messageCount: 2, updatedAt: "t1" },
      { agentId: "sub-b", messageCount: 2, updatedAt: "t2" },
    ];

    const { agents, metadata } = buildSubagentResumeStates(
      mainReplayWithTwoTaskCalls(),
      summaries,
    );

    expect(replayTexts(agents["sub-a"])).toContain("answer one");
    expect(replayTexts(agents["sub-b"])).toContain("answer two");
    expect(metadata["sub-a"]).toEqual({ parentAgentId: "main" });
  });

  it("mixes exact and FIFO without double-claiming a Task call", () => {
    // sub-b claims task-1 exactly; sub-a (unstamped) gets the leftover call
    // (task-2) rather than stealing task-1.
    const summaries: SubagentSummary[] = [
      { agentId: "sub-a", messageCount: 2, updatedAt: "t1" },
      { agentId: "sub-b", messageCount: 2, updatedAt: "t2", parentToolCallId: "task-1" },
    ];

    const { agents } = buildSubagentResumeStates(mainReplayWithTwoTaskCalls(), summaries);

    expect(replayTexts(agents["sub-a"])).toContain("answer two");
    expect(replayTexts(agents["sub-b"])).toContain("answer one");
  });

  it("drops orphaned summaries and unpaired Task calls", () => {
    const extra: SubagentSummary[] = [
      { agentId: "sub-a", messageCount: 2, updatedAt: "t1", parentToolCallId: "task-2" },
      { agentId: "orphan", messageCount: 2, updatedAt: "t2", parentToolCallId: "no-such-call" },
    ];

    const { agents, metadata } = buildSubagentResumeStates(
      mainReplayWithTwoTaskCalls(),
      extra,
    );

    expect(agents["sub-a"]).toBeDefined();
    expect(agents["orphan"]).toBeUndefined();
    expect(metadata["orphan"]).toBeUndefined();
  });
});
