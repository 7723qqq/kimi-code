/** @jsxImportSource @opentui/solid */
/**
 * TUI2 Coding Plan Config Dialog.
 *
 * Provides interactive property editing for LLM/Coding Plan parameters:
 * protocol, stream, temperature, maxTokens, enableThinking, searchDisable,
 * showRefLabel, loraId, reasoningEffort.
 *
 * Status: REAL (tui2). SolidJS component replacing v1 Container.
 */

import type { Component } from 'solid-js';
import { createSignal, For, Show } from 'solid-js';

import { t } from '#/i18n';
import { Box } from '../common/box';
import { Text } from '../common/text';

export interface CodingPlanConfigProps {
  readonly currentConfig: Record<string, unknown>;
  readonly onSave: (config: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}

const FIELD_ORDER = [
  'protocol',
  'stream',
  'temperature',
  'maxTokens',
  'enableThinking',
  'searchDisable',
  'showRefLabel',
  'loraId',
  'reasoningEffort',
] as const;

function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    protocol: t('tui.codingPlan.fieldProtocol'),
    stream: t('tui.codingPlan.fieldStream'),
    temperature: t('tui.codingPlan.fieldTemperature'),
    maxTokens: t('tui.codingPlan.fieldMaxTokens'),
    enableThinking: t('tui.codingPlan.fieldEnableThinking'),
    searchDisable: t('tui.codingPlan.fieldSearchDisable'),
    showRefLabel: t('tui.codingPlan.fieldShowRefLabel'),
    loraId: t('tui.codingPlan.fieldLoraId'),
    reasoningEffort: t('tui.codingPlan.fieldReasoningEffort'),
  };
  return labels[key] ?? key;
}

interface FieldSchema {
  parse: (raw: string) => unknown;
  validate?: (value: unknown) => boolean;
}

const FIELD_SCHEMAS: Record<string, FieldSchema> = {
  protocol: { parse: (raw) => raw },
  stream: { parse: (raw) => raw === 'true' },
  temperature: {
    parse: (raw) => Number(raw),
    validate: (v) =>
      typeof v === 'number' && !Number.isNaN(v) && (v as number) >= 0 && (v as number) <= 2,
  },
  maxTokens: {
    parse: (raw) => Number(raw),
    validate: (v) =>
      typeof v === 'number' && !Number.isNaN(v) && Number.isInteger(v) && (v as number) >= 1,
  },
  enableThinking: { parse: (raw) => raw === 'true' },
  searchDisable: { parse: (raw) => raw === 'true' },
  showRefLabel: { parse: (raw) => raw === 'true' },
  loraId: { parse: (raw) => raw },
  reasoningEffort: { parse: (raw) => raw },
};

export const CodingPlanConfigDialog: Component<CodingPlanConfigProps> = (props) => {
  const initialFields: Record<string, string> = {};
  for (const key of FIELD_ORDER) {
    const val = props.currentConfig[key];
    // JSON.stringify keeps objects readable; primitives stringify identically.
    initialFields[key] =
      val === undefined || val === null ? '' : JSON.stringify(val)?.replace(/^"(.*)"$/s, '$1') ?? '';
  }

  const [fields] = createSignal<Record<string, string>>(initialFields);
  const [selectedIndex] = createSignal(0);
  const [errorMsg, setErrorMsg] = createSignal('');

  // TODO: not wired to an editor/host action yet
  const _submit = () => {
    setErrorMsg('');
    const current = fields();
    const config: Record<string, unknown> = {};
    for (const key of FIELD_ORDER) {
      const raw = current[key];
      if (raw === undefined || raw.length === 0) continue;
      const schema = FIELD_SCHEMAS[key];
      if (schema !== undefined) {
        const parsed = schema.parse(raw);
        if (schema.validate !== undefined && !schema.validate(parsed)) {
          setErrorMsg(t('tui.codingPlan.invalidValue', { key, raw }));
          return;
        }
        config[key] = parsed;
      } else {
        config[key] = raw;
      }
    }
    props.onSave(config);
  };

  return (
    <Box flexDirection="column" borderStyle="single" borderColor="#4FA8FF" padding={1} width="100%">
      <Text fg="#4FA8FF">{t('tui.codingPlan.title')}</Text>
      <Box flexDirection="column" paddingTop={1} paddingBottom={1}>
        <For each={FIELD_ORDER}>
          {(key, i) => {
            const isSelected = () => i() === selectedIndex();
            const label = fieldLabel(key);
            const val = () => fields()[key] ?? '';
            return (
              <Box flexDirection="row">
                <Text fg={isSelected() ? '#4FA8FF' : '#888888'}>
                  {isSelected() ? '> ' : '  '}
                </Text>
                <Text fg={isSelected() ? '#FFFFFF' : '#CCCCCC'}>
                  {label}: {val()}
                  {isSelected() ? '█' : ''}
                </Text>
              </Box>
            );
          }}
        </For>
      </Box>
      <Show when={errorMsg().length > 0}>
        <Text fg="#FF5555">{errorMsg()}</Text>
      </Show>
      <Text fg="#666666">{t('tui.codingPlan.navHint')}</Text>
    </Box>
  );
};
