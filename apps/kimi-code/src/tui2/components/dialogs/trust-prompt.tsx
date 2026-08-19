/** @jsxImportSource @opentui/solid */
/**
 * TUI2 workspace-trust prompt — the pre-session gate that asks the user
 * to trust or distrust the current workspace. Trusting it enables the
 * project's `.mcp.json` servers; distrusting it skips them.
 *
 * Replaces the v1 `TrustPromptComponent` (a pi-tui `Component`) with an
 * opentui SolidJS view. Esc resolves to `'distrust'` (matching v1) — a
 * workspace must be explicitly trusted, never implicitly trusted. The
 * default cursor lands on index 1 (`distrust`) for the same reason.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { createSignal, For, Show } from 'solid-js'
import { useKeyboard } from '@opentui/solid'
import type { ColorInput, KeyEvent } from '@opentui/core'

import type { WorkspaceTrustMcpServerInfo } from '@moonshot-ai/kimi-code-sdk'

import { t } from '#/i18n'

import { SELECT_POINTER } from '../../constant/symbols'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export type TrustPromptChoice = 'trust' | 'distrust'

export interface TrustPromptProps {
  readonly workDir: string
  /** Project-level MCP servers that trusting would enable; may be empty. */
  readonly gatedMcpServers: readonly WorkspaceTrustMcpServerInfo[]
  /** Esc resolves to 'distrust' as well. */
  readonly onSelect: (choice: TrustPromptChoice) => void
}

interface TrustPromptOption {
  readonly value: TrustPromptChoice
  readonly label: string
  readonly description: string
}

const TRUST_OPTIONS: readonly TrustPromptOption[] = [
  {
    value: 'trust',
    label: t('tui.dialogs.trustPrompt.trustLabel'),
    description: t('tui.dialogs.trustPrompt.trustDesc'),
  },
  {
    value: 'distrust',
    label: t('tui.dialogs.trustPrompt.distrustLabel'),
    description: t('tui.dialogs.trustPrompt.distrustDesc'),
  },
]

function wrapPlain(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width)
  const words = text.split(/\s+/).filter((word) => word.length > 0)
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const candidate = current.length === 0 ? word : `${current} ${word}`
    if (candidate.length <= safeWidth) {
      current = candidate
      continue
    }
    if (current.length > 0) lines.push(current)
    current = word.length <= safeWidth ? word : `${word.slice(0, Math.max(1, safeWidth - 1))}…`
  }
  if (current.length > 0) lines.push(current)
  return lines.length > 0 ? lines : ['']
}

/**
 * Drops C0/C1 control characters (including ESC) from workspace-supplied
 * text: the trust prompt renders before the workspace is trusted, so a
 * planted `.mcp.json` must not inject terminal control sequences into it.
 */
function sanitizeForDisplay(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) continue
    result += char
  }
  return result
}

function formatMcpTarget(server: WorkspaceTrustMcpServerInfo): string {
  if (server.transport === 'stdio') {
    const args = server.args === undefined ? '' : ` args=${JSON.stringify(server.args)}`
    const cwd = server.cwd === undefined ? '' : ` cwd=${server.cwd}`
    return sanitizeForDisplay(
      `${server.name} (stdio): command=${server.command ?? ''}${args}${cwd}`,
    )
  }
  return sanitizeForDisplay(`${server.name} (${server.transport}): url=${server.url ?? ''}`)
}

export const TrustPrompt: Component<TrustPromptProps> = (props) => {
  const [selectedIndex, setSelectedIndex] = createSignal(1)

  function applyKey(event: KeyEvent): void {
    if (event.repeated === true) return
    switch (event.name) {
      case 'escape':
        event.stopPropagation()
        props.onSelect('distrust')
        return
      case 'up':
        setSelectedIndex((i) => Math.max(0, i - 1))
        return
      case 'down':
        setSelectedIndex((i) => Math.min(TRUST_OPTIONS.length - 1, i + 1))
        return
      case 'return':
      case 'enter':
      case 'space':
        event.stopPropagation()
        {
          const opt = TRUST_OPTIONS[selectedIndex()]
          if (opt !== undefined) props.onSelect(opt.value)
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
  const textMutedFg = (): ColorInput => currentTheme.color('textMuted')
  const textStrongFg = (): ColorInput => currentTheme.color('textStrong')
  const warningFg = (): ColorInput => currentTheme.color('warning')

  return (
    <Box flexDirection="column">
      {/* Top border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
      {/* Title */}
      <Box>
        <Text fg={titleFg()} attributes={titleAttrs()}>{` ${t('tui.dialogs.trustPrompt.title')}`}</Text>
      </Box>
      {/* Hint */}
      <Box>
        <Text fg={textMutedFg()}>{` ${t('tui.dialogs.trustPrompt.navHint')}`}</Text>
      </Box>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* workDir */}
      <For each={wrapPlain(props.workDir, 80)}>
        {(line) => (
          <Box>
            <Text fg={textStrongFg()}>{` ${line}`}</Text>
          </Box>
        )}
      </For>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Notice */}
      <For each={wrapPlain(t('tui.dialogs.trustPrompt.notice'), 80)}>
        {(line) => (
          <Box>
            <Text fg={textMutedFg()}>{` ${line}`}</Text>
          </Box>
        )}
      </For>
      {/* MCP gate */}
      <Show when={props.gatedMcpServers.length > 0}>
        <Box>
          <Text fg={warningFg()}>{` ${t('tui.dialogs.trustPrompt.projectMcpTargets')}`}</Text>
        </Box>
        <For each={props.gatedMcpServers}>
          {(server) => (
            <For each={wrapPlain(formatMcpTarget(server), 76)}>
              {(line) => (
                <Box>
                  <Text fg={warningFg()}>{`   ${line}`}</Text>
                </Box>
              )}
            </For>
          )}
        </For>
      </Show>
      {/* Blank */}
      <Box>
        <Text>{''}</Text>
      </Box>
      {/* Options */}
      <For each={TRUST_OPTIONS}>
        {(option, i) => {
          const selected = (): boolean => i() === selectedIndex()
          return (
            <>
              <Box flexDirection="row">
                <Text fg={selected() ? titleFg() : textDimFg()}>{`  ${selected() ? SELECT_POINTER : ' '} `}</Text>
                <Text
                  fg={selected() ? titleFg() : textFg()}
                  attributes={selected() ? titleAttrs() : undefined}
                >
                  {option.label}
                </Text>
              </Box>
              <For each={wrapPlain(option.description, 76)}>
                {(line) => (
                  <Box>
                    <Text fg={textMutedFg()}>{`    ${line}`}</Text>
                  </Box>
                )}
              </For>
              <Show when={i() < TRUST_OPTIONS.length - 1}>
                <Box>
                  <Text>{''}</Text>
                </Box>
              </Show>
            </>
          )
        }}
      </For>
      {/* Bottom border */}
      <Box>
        <Text fg={borderFg()}>─</Text>
      </Box>
    </Box>
  )
}