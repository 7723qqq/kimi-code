import type { Event } from '@moonshot-ai/kimi-code-sdk';
import { describe, expect, it, vi } from 'vitest';

import { AssistantMessageComponent } from '#/tui/components/messages/assistant-message';
import { StepSummaryComponent } from '#/tui/components/messages/step-summary';
import { ThinkingComponent } from '#/tui/components/messages/thinking';
import { ToolCallComponent } from '#/tui/components/messages/tool-call';
import {
  TRANSCRIPT_KEEP_RECENT_ASSISTANT,
  TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED,
  TRANSCRIPT_KEEP_RECENT_STEPS,
} from '#/tui/utils/transcript-window';

import { makeDriver, stripSgr, type MessageDriver } from './kimi-tui-message-flow-helpers';

describe('transcript step and assistant folding', () => {
  function driveSteps(driver: MessageDriver, cycles: number): void {
    for (let i = 0; i < cycles; i++) {
      driver.sessionEventHandler.handleEvent(
        {
          type: 'assistant.delta',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          delta: `msg-${i} `,
        } as Event,
        vi.fn(),
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'tool.call.started',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          toolCallId: `call_${i}`,
          name: 'Bash',
          args: { command: 'ls' },
        } as Event,
        vi.fn(),
      );
      driver.sessionEventHandler.handleEvent(
        {
          type: 'tool.result',
          agentId: 'main',
          sessionId: 'ses-1',
          turnId: 1,
          toolCallId: `call_${i}`,
          output: 'ok',
          isError: undefined,
        } as Event,
        vi.fn(),
      );
    }
  }

  it('folds the oldest assistant messages and steps beyond their per-turn caps', async () => {
    const { driver, session } = await makeDriver();
    driver.handleUserInput('fold me');
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });

    const cycles = Math.max(TRANSCRIPT_KEEP_RECENT_ASSISTANT, TRANSCRIPT_KEEP_RECENT_STEPS) + 7;
    driveSteps(driver, cycles);

    const children = driver.state.transcriptContainer.children;
    const assistantCount = children.filter(
      (child) => child instanceof AssistantMessageComponent,
    ).length;
    const toolCount = children.filter((child) => child instanceof ToolCallComponent).length;
    expect(assistantCount).toBe(TRANSCRIPT_KEEP_RECENT_ASSISTANT);
    expect(toolCount).toBe(TRANSCRIPT_KEEP_RECENT_STEPS);

    const summaries = children.filter((child) => child instanceof StepSummaryComponent);
    expect(summaries).toHaveLength(1);
    const summaryText = stripSgr(summaries[0]!.render(120).join('\n'));
    expect(summaryText).toContain(`call ${cycles - TRANSCRIPT_KEEP_RECENT_STEPS} tools`);
    expect(summaryText).toContain(`${cycles - TRANSCRIPT_KEEP_RECENT_ASSISTANT} messages`);

    const assistantEntries = driver.state.transcriptEntries.filter(
      (entry) => entry.kind === 'assistant',
    );
    expect(assistantEntries).toHaveLength(cycles);
  });

  it('does not fold a turn within the caps', async () => {
    const { driver } = await makeDriver();
    driver.handleUserInput('small turn');
    driveSteps(driver, 3);

    const children = driver.state.transcriptContainer.children;
    expect(children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(3);
    expect(children.filter((child) => child instanceof ToolCallComponent)).toHaveLength(3);
    expect(children.filter((child) => child instanceof StepSummaryComponent)).toHaveLength(0);
  });

  it('folds a completed turn down to its conclusion tail on turn end', async () => {
    const { driver, session } = await makeDriver();
    driver.handleUserInput('round one');
    await vi.waitFor(() => {
      expect(session.prompt).toHaveBeenCalled();
    });
    const cycles = 10;
    driveSteps(driver, cycles);

    let children = driver.state.transcriptContainer.children;
    expect(children.filter((child) => child instanceof AssistantMessageComponent)).toHaveLength(
      cycles,
    );

    driver.sessionEventHandler.handleEvent(
      {
        type: 'turn.ended',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        reason: 'completed',
      } as Event,
      vi.fn(),
    );

    children = driver.state.transcriptContainer.children;
    const assistants = children.filter((child) => child instanceof AssistantMessageComponent);
    expect(assistants).toHaveLength(TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED);

    const summaries = children.filter((child) => child instanceof StepSummaryComponent);
    expect(summaries).toHaveLength(1);
    const summaryText = stripSgr(summaries[0]!.render(120).join('\n'));
    expect(summaryText).toContain(
      `${cycles - TRANSCRIPT_KEEP_RECENT_ASSISTANT_COMPLETED} messages`,
    );

    expect(children.filter((child) => child instanceof ToolCallComponent)).toHaveLength(cycles);

    const lastAssistant = assistants.at(-1)!;
    expect(stripSgr(lastAssistant.render(120).join('\n'))).toContain(`msg-${cycles - 1}`);
  });
});

describe('footer ctrl+o hint', () => {
  function emitBashResult(driver: MessageDriver, toolCallId: string, output: string): void {
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        name: 'Bash',
        args: { command: 'pnpm test' },
      } as Event,
      vi.fn(),
    );
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.result',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        output,
        isError: undefined,
      } as Event,
      vi.fn(),
    );
  }

  function renderFooterLine1(driver: MessageDriver): string {
    return stripSgr(driver.state.footer.render(160)[0] ?? '');
  }

  it('offers expand while a card hides output and collapse once it is shown', async () => {
    const { driver } = await makeDriver();
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');

    emitBashResult(
      driver,
      'call_bash',
      ['line1', 'line2', 'line3', 'line4', 'Tests 5 passed'].join('\n'),
    );
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');

    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('stays silent when every card shows its whole output', async () => {
    const { driver } = await makeDriver();
    emitBashResult(driver, 'call_bash', ['line1', 'line2', 'line3'].join('\n'));
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });

  it('keeps the collapse hint for an expanded card that slid out of the expansion window', async () => {
    const { driver } = await makeDriver();
    emitBashResult(
      driver,
      'call_bash',
      ['line1', 'line2', 'line3', 'line4', 'Tests 5 passed'].join('\n'),
    );
    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    // Four later user turns move the expanded card before the three-turn
    // cutoff; nothing collapses it, and ctrl+o would still visibly collapse it.
    for (let i = 0; i < 4; i++) {
      driver.appendTranscriptEntry({
        id: `later-${String(i)}`,
        kind: 'user',
        renderMode: 'plain',
        content: `next ${String(i)}`,
      });
    }
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });
});
