import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { Event } from '@moonshot-ai/kimi-code-sdk';
import type { TuiMouseEvent } from '@moonshot-ai/pi-tui';
import { describe, expect, it, vi } from 'vitest';

import {
  emitTurn,
  makeDriver,
  makeSession,
  makeTempHome,
  renderTranscript,
  stripSgr,
  type MessageDriver,
} from './kimi-tui-message-flow-helpers';

describe('KimiTUI session rating survey', () => {
  it('runs the end-to-end rating flow after five user turns', async () => {
    vi.useFakeTimers();
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver, harness } = await makeDriver();
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(
          (driver.surveyController as unknown as { cooldownReady: boolean }).cooldownReady,
        ).toBe(true);
      });
      vi.useFakeTimers();
      harness.track.mockClear();

      for (let turn = 1; turn <= 4; turn++) emitTurn(driver, turn);
      vi.advanceTimersByTime(600_000);
      vi.advanceTimersByTime(2_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      emitTurn(driver, 5, () => {
        driver.sessionEventHandler.handleEvent(
          {
            type: 'tool.call.started',
            agentId: 'main',
            sessionId: 'ses-1',
            turnId: 5,
            toolCallId: 'call_1',
            name: 'Read',
            args: { path: 'a.ts' },
          } as Event,
          () => {},
        );
        driver.sessionEventHandler.handleEvent(
          {
            type: 'agent.status.updated',
            agentId: 'main',
            sessionId: 'ses-1',
            contextTokens: 4321,
            usage: {
              total: { inputOther: 100, output: 20, inputCacheRead: 30, inputCacheCreation: 10 },
            },
          } as Event,
          () => {},
        );
      });
      vi.advanceTimersByTime(2_000);
      const docked = stripSgr(driver.state.surveyContainer.render(120).join('\n'));
      expect(docked).toContain('How is Kimi doing this session? (optional)');
      expect(docked).toContain('1: Bad  2: Fine  3: Good  0: Dismiss');
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);
      expect(harness.trackWithContext).toHaveBeenCalledWith(
        'feedback_survey',
        {
          event_type: 'appeared',
          appearance_id: expect.any(String),
          appearance_index: 1,
          response: undefined,
          current_model: 'k2',
          user_turn_count: 5,
          cumulative_tokens: 160,
          virtual_context_tokens: 4321,
          tool_call_count: 1,
          compaction_count: 0,
          permission_mode: 'manual',
          thinking_effort: 'off',
          subagent_count: 0,
          swarm_run_count: 0,
          config_probability: 0.005,
          config_on_for_models: '*',
          config_min_time_before_feedback_ms: 600_000,
          config_min_user_turns_before_feedback: 5,
          config_min_time_between_feedback_ms: 3_600_000,
          config_min_user_turns_between_feedback: 10,
          config_min_time_between_global_feedback_ms: 100_000_000,
          config_long_context_survey_threshold: 200_000,
          config_long_context_probability: 0.2,
          config_long_context_trigger_mode: 'virtual_context',
        },
        { sessionId: 'ses-1' },
      );
      const appearanceId = (harness.trackWithContext.mock.calls[0]![1] as { appearance_id: string })
        .appearance_id;

      driver.state.editor.handleInput('1');
      vi.advanceTimersByTime(400);
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(600);
      driver.state.editor.setText('');
      driver.state.editor.handleInput('1');
      vi.advanceTimersByTime(400);
      expect(driver.state.editor.getText()).toBe('');
      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'Feedback: Bad · [escape: undo]',
      );
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);

      driver.state.editor.handleInput('\u001B');
      vi.advanceTimersByTime(3_000);
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);
      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'How is Kimi doing this session? (optional)',
      );

      driver.state.editor.setText('');
      driver.state.editor.handleInput('3');
      vi.advanceTimersByTime(400);
      vi.advanceTimersByTime(3_000);
      const responded = harness.trackWithContext.mock.calls
        .filter(
          (call) =>
            call[0] === 'feedback_survey' &&
            (call[1] as { event_type?: string }).event_type === 'responded',
        )
        .map((call) => call[1] as { response?: string; appearance_id: string });
      expect(responded.map((call) => call.response)).toEqual(['good']);
      expect(responded.map((call) => call.appearance_id)).toEqual([appearanceId]);

      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'Thanks for your feedback!',
      );
      vi.advanceTimersByTime(5_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      vi.useRealTimers();
      const stateFile = join(homeDir, 'feedback-survey-state.json');
      await vi.waitFor(() => {
        expect(existsSync(stateFile)).toBe(true);
      });
      const persisted = JSON.parse(await readFile(stateFile, 'utf-8')) as {
        version: number;
        last_shown_time: number;
      };
      expect(persisted.version).toBe(1);
      expect(typeof persisted.last_shown_time).toBe('number');
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('shows the long-context survey once the context window crosses the threshold', async () => {
    vi.useFakeTimers();
    const homeDir = await makeTempHome();
    process.env['KIMI_CODE_HOME'] = homeDir;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver, harness } = await makeDriver();
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(
          (driver.surveyController as unknown as { cooldownReady: boolean }).cooldownReady,
        ).toBe(true);
      });
      vi.useFakeTimers();
      harness.track.mockClear();

      emitTurn(driver, 1, () => {
        driver.sessionEventHandler.handleEvent(
          {
            type: 'agent.status.updated',
            agentId: 'main',
            sessionId: 'ses-1',
            contextTokens: 205_000,
            usage: {
              total: {
                inputOther: 1_000,
                output: 500,
                inputCacheRead: 0,
                inputCacheCreation: 0,
              },
            },
          } as Event,
          () => {},
        );
      });
      vi.advanceTimersByTime(2_000);

      expect(stripSgr(driver.state.surveyContainer.render(120).join('\n'))).toContain(
        'How is Kimi doing this session? (optional)',
      );
      expect(harness.trackWithContext).toHaveBeenCalledTimes(1);
      expect(harness.trackWithContext).toHaveBeenCalledWith(
        'long_context_survey',
        expect.objectContaining({
          event_type: 'appeared',
          appearance_index: 1,
          user_turn_count: 1,
          cumulative_tokens: 1500,
          virtual_context_tokens: 205_000,
          config_long_context_survey_threshold: 200_000,
          config_long_context_probability: 0.2,
          config_long_context_trigger_mode: 'virtual_context',
        }),
        { sessionId: 'ses-1' },
      );

      vi.useRealTimers();
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(existsSync(join(homeDir, 'feedback-survey-state.json'))).toBe(false);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('ignores non-user turns for the survey warmup', async () => {
    vi.useFakeTimers();
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver } = await makeDriver();
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(
          (driver.surveyController as unknown as { cooldownReady: boolean }).cooldownReady,
        ).toBe(true);
      });
      vi.useFakeTimers();
      const emit = (event: Event) => {
        driver.sessionEventHandler.handleEvent(event, () => {});
      };
      const cronOrigin = {
        kind: 'cron_job',
        jobId: 'job-42',
        cron: '*/5 * * * *',
        recurring: true,
        coalescedCount: 1,
        stale: false,
      };

      vi.advanceTimersByTime(600_000);
      for (let turn = 1; turn <= 5; turn++) {
        emit({ type: 'turn.started', agentId: 'main', turnId: turn, origin: cronOrigin } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      vi.advanceTimersByTime(2_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      for (let turn = 6; turn <= 10; turn++) emitTurn(driver, turn);
      vi.advanceTimersByTime(2_000);
      expect(driver.state.surveyContainer.children).not.toHaveLength(0);

      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(existsSync(join(process.env['KIMI_CODE_HOME']!, 'feedback-survey-state.json'))).toBe(
          true,
        );
      });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });

  it('counts user-slash skill and plugin command turns toward the survey warmup', async () => {
    vi.useFakeTimers();
    process.env['KIMI_CODE_HOME'] = await makeTempHome();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const { driver } = await makeDriver();
      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(
          (driver.surveyController as unknown as { cooldownReady: boolean }).cooldownReady,
        ).toBe(true);
      });
      vi.useFakeTimers();
      const emit = (event: Event) => {
        driver.sessionEventHandler.handleEvent(event, () => {});
      };

      vi.advanceTimersByTime(600_000);
      for (let turn = 1; turn <= 5; turn++) {
        emit({
          type: 'turn.started',
          agentId: 'main',
          turnId: turn,
          origin: {
            kind: 'skill_activation',
            activationId: `a${turn}`,
            skillName: 'review',
            trigger: 'model-tool',
          },
        } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      vi.advanceTimersByTime(2_000);
      expect(driver.state.surveyContainer.children).toHaveLength(0);

      for (let turn = 6; turn <= 8; turn++) {
        emit({
          type: 'turn.started',
          agentId: 'main',
          turnId: turn,
          origin: {
            kind: 'skill_activation',
            activationId: `a${turn}`,
            skillName: 'review',
            trigger: 'user-slash',
          },
        } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      for (let turn = 9; turn <= 10; turn++) {
        emit({
          type: 'turn.started',
          agentId: 'main',
          turnId: turn,
          origin: {
            kind: 'plugin_command',
            activationId: `p${turn}`,
            pluginId: 'fmt',
            commandName: 'fmt',
            trigger: 'user-slash',
          },
        } as Event);
        emit({ type: 'turn.ended', agentId: 'main', turnId: turn, reason: 'completed' } as Event);
      }
      vi.advanceTimersByTime(2_000);
      expect(driver.state.surveyContainer.children).not.toHaveLength(0);

      vi.useRealTimers();
      await vi.waitFor(() => {
        expect(existsSync(join(process.env['KIMI_CODE_HOME']!, 'feedback-survey-state.json'))).toBe(
          true,
        );
      });
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  });
});

describe('transcript fold block clicks', () => {
  const transcriptWidth = 120;

  function hiddenOutput(name: string): string {
    return [`${name}-body`, `${name}-mid`, `${name}-more`, `${name}-tail`].join('\n');
  }

  function emitBash(
    driver: MessageDriver,
    toolCallId: string,
    command: string,
    output: string,
  ): void {
    driver.sessionEventHandler.handleEvent(
      {
        type: 'tool.call.started',
        agentId: 'main',
        sessionId: 'ses-1',
        turnId: 1,
        toolCallId,
        name: 'Bash',
        args: { command },
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

  function clickTranscriptLine(driver: MessageDriver, needle: string): void {
    const lines = driver.state.transcriptContainer.render(transcriptWidth);
    const y = lines.findIndex((line) => stripSgr(line).includes(needle));
    expect(y).toBeGreaterThanOrEqual(0);
    const event: TuiMouseEvent = {
      type: 'click',
      button: 'left',
      x: 2,
      y,
      screenX: 2,
      screenY: y,
      width: transcriptWidth,
      height: lines.length,
      shift: false,
      alt: false,
      ctrl: false,
      clickCount: 1,
    };
    driver.state.transcriptContainer.handleMouse(event);
  }

  it('opens only the clicked tool card while the footer still offers expand', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));

    const collapsed = stripSgr(renderTranscript(driver));
    expect(collapsed).toContain('alpha-tail');
    expect(collapsed).not.toContain('alpha-body');
    expect(collapsed).not.toContain('beta-body');
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');

    clickTranscriptLine(driver, 'alpha-tail');

    const opened = stripSgr(renderTranscript(driver));
    expect(opened).toContain('alpha-body');
    expect(opened).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');

    clickTranscriptLine(driver, 'alpha-body');

    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain('alpha-body');
    expect(closed).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('lets ctrl+o overwrite a clicked card and keeps a neighbor open', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));

    clickTranscriptLine(driver, 'alpha-tail');
    driver.toggleToolOutputExpansion();

    const expanded = stripSgr(renderTranscript(driver));
    expect(expanded).toContain('alpha-body');
    expect(expanded).toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    clickTranscriptLine(driver, 'alpha-body');

    const oneClosed = stripSgr(renderTranscript(driver));
    expect(oneClosed).not.toContain('alpha-body');
    expect(oneClosed).toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    driver.toggleToolOutputExpansion();

    const collapsed = stripSgr(renderTranscript(driver));
    expect(collapsed).not.toContain('alpha-body');
    expect(collapsed).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('closes an aged-out open card and does not open it again', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_old', 'echo old', hiddenOutput('old'));
    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).toContain('old-body');

    for (let i = 0; i < 4; i++) {
      driver.appendTranscriptEntry({
        id: `later-${String(i)}`,
        kind: 'user',
        renderMode: 'plain',
        content: `later turn ${String(i)}`,
      });
    }
    emitBash(driver, 'call_recent', 'echo recent', hiddenOutput('recent'));

    expect(stripSgr(renderTranscript(driver))).toContain('old-body');
    expect(stripSgr(renderTranscript(driver))).toContain('recent-body');

    clickTranscriptLine(driver, 'old-body');

    const oldClosed = stripSgr(renderTranscript(driver));
    expect(oldClosed).not.toContain('old-body');
    expect(oldClosed).toContain('recent-body');
    expect(driver.state.toolOutputExpanded).toBe(true);

    clickTranscriptLine(driver, 'old-tail');
    expect(stripSgr(renderTranscript(driver))).not.toContain('old-body');
    expect(stripSgr(renderTranscript(driver))).toContain('recent-body');

    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).not.toContain('old-body');
    expect(stripSgr(renderTranscript(driver))).not.toContain('recent-body');
    expect(driver.state.toolOutputExpanded).toBe(false);

    driver.toggleToolOutputExpansion();
    const reopened = stripSgr(renderTranscript(driver));
    expect(reopened).not.toContain('old-body');
    expect(reopened).toContain('recent-body');
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');
  });

  it('does not change a fold block when the click lands on message text', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    driver.appendTranscriptEntry({
      id: 'user-plain',
      kind: 'user',
      renderMode: 'plain',
      content: 'plain user sentence',
    });

    clickTranscriptLine(driver, 'plain user sentence');

    const transcript = stripSgr(renderTranscript(driver));
    expect(transcript).toContain('plain user sentence');
    expect(transcript).not.toContain('alpha-body');
    expect(transcript).toContain('alpha-tail');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('toggles a long finalized thinking block without advertising it in the footer', async () => {
    const { driver } = await makeDriver();
    const longThinking = ['think-one', 'think-two', 'think-three', 'think-four'].join('\n');
    driver.streamingUI.onThinkingUpdate(longThinking);
    const streaming = stripSgr(renderTranscript(driver));
    expect(streaming).toContain('think-four');
    expect(streaming).not.toContain('think-one');

    clickTranscriptLine(driver, 'think-four');
    expect(stripSgr(renderTranscript(driver))).not.toContain('think-one');

    driver.streamingUI.onThinkingEnd();

    const collapsed = stripSgr(renderTranscript(driver));
    expect(collapsed).toContain('think-one');
    expect(collapsed).not.toContain('think-four');
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');

    clickTranscriptLine(driver, 'think-one');

    const opened = stripSgr(renderTranscript(driver));
    expect(opened).toContain('think-four');
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');

    clickTranscriptLine(driver, 'think-four');
    expect(stripSgr(renderTranscript(driver))).not.toContain('think-four');

    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).toContain('think-four');
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
    expect(driver.state.toolOutputExpanded).toBe(true);

    driver.toggleToolOutputExpansion();
    expect(stripSgr(renderTranscript(driver))).not.toContain('think-four');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });

  it('keeps the expand hint when clicked cards are all open', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));

    clickTranscriptLine(driver, 'alpha-tail');
    clickTranscriptLine(driver, 'beta-tail');

    const opened = stripSgr(renderTranscript(driver));
    expect(opened).toContain('alpha-body');
    expect(opened).toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(false);
    expect(renderFooterLine1(driver)).toContain('ctrl+o expand');
  });

  it('drops the collapse hint after every open card is clicked shut', async () => {
    const { driver } = await makeDriver();
    emitBash(driver, 'call_alpha', 'echo alpha', hiddenOutput('alpha'));
    emitBash(driver, 'call_beta', 'echo beta', hiddenOutput('beta'));
    driver.toggleToolOutputExpansion();
    expect(renderFooterLine1(driver)).toContain('ctrl+o collapse');

    clickTranscriptLine(driver, 'alpha-body');
    clickTranscriptLine(driver, 'beta-body');

    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain('alpha-body');
    expect(closed).not.toContain('beta-body');
    expect(driver.state.toolOutputExpanded).toBe(true);
    expect(renderFooterLine1(driver)).not.toContain('ctrl+o');
  });

  it('closes a wrapped ! card that was opened from its preview', async () => {
    const marker = 'shell-tail-marker';
    const stdout = `${'x'.repeat(4000)}${marker}`;
    const runShellCommand = vi.fn(async () => ({ stdout, stderr: '', isError: false }));
    const session = makeSession({ runShellCommand });
    const { driver } = await makeDriver(session);
    driver.state.appState.inputMode = 'bash';
    driver.state.editor.inputMode = 'bash';

    driver.handleUserInput('echo-shell');
    await vi.waitFor(() => {
      const transcript = stripSgr(renderTranscript(driver));
      expect(transcript).toContain('ctrl+o to expand');
      expect(transcript).not.toContain(marker);
    });

    clickTranscriptLine(driver, 'more lines');
    expect(stripSgr(renderTranscript(driver))).toContain(marker);

    clickTranscriptLine(driver, marker);
    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain(marker);
    expect(closed).toContain('ctrl+o to expand');
    expect(driver.state.toolOutputExpanded).toBe(false);
  });

  it('closes a wide tool card that mounted while the transcript was expanded', async () => {
    const { driver } = await makeDriver();
    driver.toggleToolOutputExpansion();
    const output = `wide-head ${'w'.repeat(500)} wide-tail`;
    emitBash(driver, 'call_wide', 'echo wide', output);

    expect(stripSgr(renderTranscript(driver))).toContain('wide-tail');

    clickTranscriptLine(driver, 'echo wide');

    const closed = stripSgr(renderTranscript(driver));
    expect(closed).not.toContain('wide-tail');
    expect(closed).toContain('wide-head');
    expect(driver.state.toolOutputExpanded).toBe(true);
  });
});
