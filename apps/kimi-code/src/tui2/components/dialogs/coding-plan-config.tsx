/** @jsxImportSource @opentui/solid */
/**
 * TUI2 coding-plan config dialog — editor for a record of string fields
 * (protocol / stream / temperature / maxTokens / enableThinking /
 * searchDisable / showRefLabel / loraId / reasoningEffort).
 *
 * Replaces the v1 `CodingPlanConfigComponent` (a pi-tui `Container`) with
 * an opentui SolidJS view. ↑/↓ moves the cursor between fields; printable
 * characters are appended to the active field's buffer; Backspace deletes
 * the last character. Enter parses and validates the buffer; invalid
 * values surface an error line and keep the dialog open.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'
import { isPrintableChar, printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface CodingPlanConfigProps {
  readonly currentConfig: Record<string, unknown>
  readonly onSave: (config: Record<string, unknown>) => void
  readonly onCancel: () => void
}

const FIELD_ORDER: readonly string[] = [
  'protocol',
  'stream',
  'temperature',
  'maxTokens',
  'enableThinking',
  'searchDisable',
  'showRefLabel',
  'loraId',
  'reasoningEffort',
]

interface FieldSchema {
  parse: (raw: string) => unknown
  validate?: (value: unknown) => boolean
}

const FIELD_SCHEMAS: Record<string, FieldSchema> = {
  protocol: { parse: (raw) => raw },
  stream: { parse: (raw) => raw === 'true' },
  temperature: {
    parse: Number,
    validate: (v) =>
      typeof v === 'number' && !Number.isNaN(v) && (v as number) >= 0 && (v as number) <= 2,
  },
  maxTokens: {
    parse: Number,
    validate: (v) =>
      typeof v === 'number' && !Number.isNaN(v) && Number.isInteger(v) && (v as number) >= 1,
  },
  enableThinking: { parse: (raw) => raw === 'true' },
  searchDisable: { parse: (raw) => raw === 'true' },
  showRefLabel: { parse: (raw) => raw === 'true' },
  loraId: { parse: (raw) => raw },
  reasoningEffort: { parse: (raw) => raw },
}

function displayConfigValue(value: unknown): string {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value)
  }
  return JSON.stringify(value) ?? ''
}

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
  }
  return labels[key] ?? key
}

export const CodingPlanConfig: Component<CodingPlanConfigProps> = (props) => {
  const [fields, setFields] = createSignal<Record<string, string>>(buildInitialFields(props))
  const [selectedField, setSelectedField] = createSignal(0)
  const [errorMsg, setErrorMsg] = createSignal('')

  function buildInitialFields(current: CodingPlanConfigProps): Record<string, string> {
    const initial: Record<string, string> = {}
    for (const key of FIELD_ORDER) {
      const value = current.currentConfig[key]
      initial[key] =
        value === undefined ? '' : typeof value === 'string' ? value : displayConfigValue(value)
    }
    return initial
  }

  function updateField(key: string, mutator: (current: string) => string): void {
    setFields((prev) => ({ ...prev, [key]: mutator(prev[key] ?? '') }))
  }

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 'up':
        setSelectedField((i) => Math.max(0, i - 1))
        return
      case 'down':
        setSelectedField((i) => Math.min(FIELD_ORDER.length - 1, i + 1))
        return
      case 'return':
      case 'enter':
        event.stopPropagation()
        save()
        return
      case 'backspace':
        updateField(FIELD_ORDER[selectedField()] ?? '', (v) => v.slice(0, -1))
        return
    }
    const ch = printableChar(event.sequence ?? event.name)
    if (isPrintableChar(ch)) {
      updateField(FIELD_ORDER[selectedField()] ?? '', (v) => v + ch)
    }
  }

  function save(): void {
    setErrorMsg('')
    const config: Record<string, unknown> = {}
    for (const key of FIELD_ORDER) {
      const raw = fields()[key] ?? ''
      if (raw.length === 0) continue
      const schema = FIELD_SCHEMAS[key]
      if (schema !== undefined) {
        const parsed = schema.parse(raw)
        if (schema.validate !== undefined && !schema.validate(parsed)) {
          setErrorMsg(t('tui.codingPlan.invalidValue', { key, raw }))
          return
        }
        config[key] = parsed
      } else {
        config[key] = raw
      }
    }
    props.onSave(config)
  }

  useKeyboard(applyKey)

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  const borderFg = (): ColorInput => currentTheme.color('primary')
  const titleFg = (): ColorInput => currentTheme.color('primary')
  const titleAttrs = (): number => currentTheme.attributes('bold')
  const textFg = (): ColorInput => currentTheme.color('text')
  const textDimFg = (): ColorInput => currentTheme.color('textDim')
  const errorFg = (): ColorInput => currentTheme.color('error')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.codingPlan.title')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Field rows */}
      <For each={FIELD_ORDER}>
        {(key, i) => {
          const selected = (): boolean => i() === selectedField()
          return (
            <Box flexDirection="row">
              <Text fg={selected() ? titleFg() : textDimFg()}>{` ${selected() ? SELECT_POINTER : ' '} `}</Text>
              <Text
                fg={selected() ? titleFg() : textFg()}
                attributes={selected() ? titleAttrs() : undefined}
              >
                {`${fieldLabel(key)}: ${fields()[key] ?? ''}${selected() ? '█' : ''}`}
              </Text>
            </Box>
          )
        }}
      </For>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Error */}
      <Show when={errorMsg().length > 0}>
        <Box>
          <Text fg={errorFg()}>{` ${errorMsg()}`}</Text>
        </Box>
      </Show>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${t('tui.codingPlan.navHint')}`}</Text>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}