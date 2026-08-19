/** @jsxImportSource @opentui/solid */
/**
 * TUI2 Astron settings panel — toggle stream, temperature, max_tokens,
 * search_disable.
 *
 * Replaces the v1 `AstronSettingsComponent` (a pi-tui `Container`) with
 * an opentui SolidJS view. The panel is presentation-only: it seeds from
 * `initial` and hands the edited values back through `onSave`. The host
 * owns persistence to the `[providers.astron]` section of
 * ~/.kimi-code/config.toml (via the SDK), so this component never touches
 * config or the SDK directly.
 *
 * Field types:
 *   - bool:   Enter toggles
 *   - number: Enter enters edit mode; digits / `.` extend the buffer;
 *             Enter commits (with range validation), Esc exits editing.
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
import { printableChar } from '../../utils/printable-key'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface AstronSettings {
  stream: boolean
  temperature: number
  maxTokens: number
  searchDisable: boolean
}

// searchDisable defaults to true because coding sessions rarely benefit
// from web search and disabling it avoids unnecessary latency and cost.
export const ASTRON_DEFAULT_SETTINGS: AstronSettings = {
  stream: true,
  temperature: 1.0,
  maxTokens: 32768,
  searchDisable: true,
}

const ASTRON_TEMPERATURE_RANGE = { min: 0, max: 2 } as const
const ASTRON_MAX_TOKENS_MIN = 1

type FieldName = keyof AstronSettings

interface FieldDef {
  name: FieldName
  type: 'bool' | 'number'
}

const FIELDS: readonly FieldDef[] = [
  { name: 'stream', type: 'bool' },
  { name: 'temperature', type: 'number' },
  { name: 'maxTokens', type: 'number' },
  { name: 'searchDisable', type: 'bool' },
]

export interface AstronSettingsProps {
  readonly initial: AstronSettings
  readonly onSave: (settings: AstronSettings) => void
  readonly onCancel: () => void
}

export const AstronSettingsView: Component<AstronSettingsProps> = (props) => {
  const [settings, setSettings] = createSignal({ ...props.initial })
  const [index, setIndex] = createSignal(0)
  const [editing, setEditing] = createSignal(false)
  const [editBuffer, setEditBuffer] = createSignal('')
  const [errorMessage, setErrorMessage] = createSignal<string | null>(null)

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    const field = FIELDS[index()]
    if (field === undefined) return

    // Editing mode for number fields
    if (editing() && field.type === 'number') {
      switch (event.name) {
        case 'return':
        case 'enter': {
          const buf = editBuffer()
          if (buf.length > 0) {
            const val = Number(buf)
            if (Number.isFinite(val)) {
              if (field.name === 'temperature') {
                if (val < ASTRON_TEMPERATURE_RANGE.min || val > ASTRON_TEMPERATURE_RANGE.max) {
                  setErrorMessage(
                    `Value must be between ${ASTRON_TEMPERATURE_RANGE.min} and ${ASTRON_TEMPERATURE_RANGE.max}`,
                  )
                  return
                }
              } else if (field.name === 'maxTokens') {
                if (val < ASTRON_MAX_TOKENS_MIN) {
                  setErrorMessage(`Value must be at least ${ASTRON_MAX_TOKENS_MIN}`)
                  return
                }
              }
              setSettings((prev) => ({ ...prev, [field.name]: val }))
            }
          }
          setEditing(false)
          setEditBuffer('')
          return
        }
        case 'escape':
          event.stopPropagation()
          setEditing(false)
          setEditBuffer('')
          return
        case 'backspace':
          setEditBuffer((b) => b.slice(0, -1))
          return
      }
      const ch = printableChar(event.sequence ?? event.name)
      if (/^[0-9.]$/.test(ch)) {
        setEditBuffer((b) => b + ch)
      }
      return
    }

    switch (event.name) {
      case 'up':
        setIndex((i) => (i - 1 + FIELDS.length) % FIELDS.length)
        setErrorMessage(null)
        return
      case 'down':
        setIndex((i) => (i + 1) % FIELDS.length)
        setErrorMessage(null)
        return
      case 'return':
      case 'enter':
        if (field.type === 'bool') {
          setSettings((prev) => ({ ...prev, [field.name]: !prev[field.name] }))
        } else {
          setEditing(true)
          setEditBuffer(String(settings()[field.name]))
          setErrorMessage(null)
        }
        return
      case 'escape':
        event.stopPropagation()
        props.onCancel()
        return
      case 's':
        if (event.ctrl) {
          event.stopPropagation()
          props.onSave(settings())
          return
        }
        return
    }
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
  const successFg = (): ColorInput => currentTheme.color('success')
  const errorFg = (): ColorInput => currentTheme.color('error')
  const hintFg = (): ColorInput => currentTheme.color('textMuted')

  function fieldLabel(name: FieldName): string {
    return t(`tui.dialogs.astronSettings.${name}`)
  }

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.astronSettings.title')}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={hintFg()}>{` ${t('tui.dialogs.astronSettings.hint')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Fields */}
      <For each={FIELDS}>
        {(field, i) => {
          const selected = (): boolean => i() === index()
          return (
            <Box flexDirection="row">
              <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
              <Text
                fg={selected() ? titleFg() : textFg()}
                attributes={selected() ? titleAttrs() : undefined}
              >
                {`${fieldLabel(field.name)}: `}
              </Text>
              <Show
                when={field.type === 'bool'}
                fallback={
                  <Show
                    when={editing() && selected()}
                    fallback={
                      <Text fg={textFg()}>{String(settings()[field.name])}</Text>
                    }
                  >
                    <Text fg={titleFg()} attributes={titleAttrs()}>{`${editBuffer()}█`}</Text>
                  </Show>
                }
              >
                <Text fg={settings()[field.name] ? successFg() : textDimFg()}>
                  {settings()[field.name]
                    ? ` ${t('tui.dialogs.astronSettings.on')}`
                    : ` ${t('tui.dialogs.astronSettings.off')}`}
                </Text>
              </Show>
            </Box>
          )
        }}
      </For>
      {/* Error */}
      <Show when={errorMessage() !== null}>
        <Box>
          <Text>{''}</Text>
        </Box>
        <Box>
          <Text fg={errorFg()}>{`  ${errorMessage() ?? ''}`}</Text>
        </Box>
      </Show>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}