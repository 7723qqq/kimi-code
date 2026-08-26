/** @jsxImportSource @opentui/solid */
/**
 * TUI2 AgentActivityViewer — full-screen detail view for a background agent task.
 *
 * Renders subagent steps, reasoning, and tool activity records using OpenTUI
 * layout and SolidJS reactivity.
 *
 * Status: REAL (tui2). SolidJS component replacing v1 Container.
 */

import type { Component } from 'solid-js';
import { For, Show } from 'solid-js';

import { t } from '#/i18n';
import type { BackgroundTaskInfo } from '@moonshot-ai/kimi-code-sdk';
import type { SubagentActivityRecord } from '../../controllers/subagent-activity-store';
import { Box } from '../common/box';
import { Text } from '../common/text';

export interface AgentActivityViewerProps {
  readonly taskId: string;
  readonly info?: BackgroundTaskInfo;
  readonly record?: SubagentActivityRecord;
  readonly workspaceDir?: string;
  readonly onClose: () => void;
}

export const AgentActivityViewer: Component<AgentActivityViewerProps> = (props) => {
  const statusLabel = () => props.info?.status ?? props.record?.status ?? 'running';
  const description = () => props.info?.description ?? props.record?.description ?? props.taskId;

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="#4FA8FF" width="100%" height="100%">
      {/* Header */}
      <Box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} backgroundColor="#1A1A2E">
        <Text fg="#4FA8FF">
          {t('tui.tasksBrowser.agentActivityTitle', { id: props.taskId })}
        </Text>
        <Text fg="#AAAAAA">[{statusLabel()}]</Text>
      </Box>

      {/* Description */}
      <Box paddingLeft={1} paddingRight={1} paddingTop={1} paddingBottom={1}>
        <Text fg="#E0E0E0">{description()}</Text>
      </Box>

      {/* Body: Activity Records / Tool Calls */}
      <Box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <Show
          when={props.record && props.record.steps && props.record.steps.length > 0}
          fallback={<Text fg="#666666">{t('tui.tasksBrowser.noActivity')}</Text>}
        >
          <For each={props.record?.steps}>
            {(step) => (
              <Box flexDirection="column" borderStyle="single" borderColor="#333344" padding={1}>
                <Show when={step.textTail}>
                  <Text fg="#DCDCDC">{step.textTail}</Text>
                </Show>
                <Show when={step.toolCalls && step.toolCalls.length > 0}>
                  <For each={step.toolCalls}>
                    {(tc) => (
                      <Box flexDirection="column" paddingTop={1}>
                        <Text fg="#4FA8FF">⚙ {tc.name} ({tc.status})</Text>
                        <Show when={tc.liveOutputTail}>
                          <Text fg="#999999">  &gt; {tc.liveOutputTail}</Text>
                        </Show>
                      </Box>
                    )}
                  </For>
                </Show>
              </Box>
            )}
          </For>
        </Show>
      </Box>

      {/* Footer Navigation */}
      <Box flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1} borderStyle="single" borderColor="#333333">
        <Text fg="#666666">{t('tui.tasksBrowser.navHint')}</Text>
        <Text fg="#4FA8FF">[Esc: Close]</Text>
      </Box>
    </Box>
  );
};
