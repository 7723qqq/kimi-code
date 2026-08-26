/** @jsxImportSource @opentui/solid */
/**
 * TUI2 welcome panel shown at the top of the TUI.
 *
 * Replaces `tui/components/chrome/welcome.ts`'s `WelcomeComponent` (a
 * pi-tui `Component` whose `render(width)` returned ANSI strings) with an
 * opentui SolidJS view: a rounded-border box with the logo, session, model,
 * and version. All colors flow through the active palette so theme switches
 * take effect on the next render.
 *
 * The `/dance` easter egg is honored: when the rainbow dance is active the
 * logo + title render as per-character rainbow spans (the v1
 * `renderDanceWelcomeHeader` returned chalk ANSI strings, which opentui
 * cannot consume, so the tui2 view rebuilds the same visual from the shared
 * dance palette).
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component } from 'solid-js'
import { For, Show } from 'solid-js'
import { effectiveModelAlias, type ModelAlias } from '@moonshot-ai/kimi-code-sdk'
import type { ColorInput } from '@opentui/core'

import { t } from '#/i18n'
import { getDanceRainbowPalette, getRainbowDanceView, isRainbowDancing } from '../../easter-eggs/dance'
import { currentTheme } from '../../theme'

import { Box } from '../common/box'
import { Text } from '../common/text'

export interface WelcomeViewProps {
  readonly model: string
  readonly availableModels: Record<string, ModelAlias>
  readonly workDir: string
  readonly sessionId: string
  readonly version: string
  readonly mcpServersSummary: string | null
}

const LOGO = ['▐█▛█▛█▌', '▐█████▌'] as const;
const DANCE_TITLE = 'Welcome to Kimi Code!';

/** Per-character rainbow text built from the shared dance palette. */
function RainbowText(props: { text: string; offset: number; bold?: boolean }) {
  const palette = getDanceRainbowPalette()
  return (
    <Box flexDirection="row">
      <For each={Array.from(props.text)}>
        {(char, index) => {
          if (char === ' ') return <Text>{' '}</Text>
          const color = palette[(props.offset + index()) % palette.length] ?? palette[0]
          return (
            <Text fg={color} attributes={props.bold === true ? currentTheme.attributes('bold') : undefined}>
              {char}
            </Text>
          )
        }}
      </For>
    </Box>
  )
}

export const WelcomeView: Component<WelcomeViewProps> = (props) => {
  const primary = (): ColorInput => currentTheme.color('primary')
  const textDim = (): ColorInput => currentTheme.color('textDim')
  const textStrong = (): ColorInput => currentTheme.color('textStrong')
  const warning = (): ColorInput => currentTheme.color('warning')
  const text = (): ColorInput => currentTheme.color('text')

  const isLoggedOut = (): boolean => props.model.length === 0
  const modelValue = (): string => {
    if (isLoggedOut()) return t('tui.chrome.welcome.modelNotSet')
    const active = props.availableModels[props.model]
    const effective = active === undefined ? undefined : effectiveModelAlias(active)
    return effective?.displayName ?? effective?.model ?? props.model
  }
  const prompt = (): string =>
    isLoggedOut() ? t('tui.chrome.welcome.loggedOutPrompt') : t('tui.chrome.welcome.helpPrompt')
  const promptFg = (): ColorInput => (isLoggedOut() ? warning() : textDim())

  const dancing = (): boolean => isRainbowDancing()
  const dancePhase = (): number => getRainbowDanceView()?.phase ?? 0

  return (
    <Box
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={primary()}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <Box flexDirection="row" gap={2}>
        <Box flexDirection="column">
          <Show
            when={dancing()}
            fallback={
              <>
                <Text fg={primary()}>{LOGO[0]}</Text>
                <Text fg={primary()}>{LOGO[1]}</Text>
              </>
            }
          >
            <RainbowText text={LOGO[0]} offset={dancePhase()} />
            <RainbowText text={LOGO[1]} offset={dancePhase() + 3} />
          </Show>
        </Box>
        <Box flexDirection="column">
          <Show
            when={dancing()}
            fallback={
              <Text fg={textStrong()} attributes={currentTheme.attributes('bold')}>
                {t('tui.chrome.welcome.title')}
              </Text>
            }
          >
            <RainbowText text={DANCE_TITLE} offset={dancePhase() + 2} bold />
          </Show>
          <Text fg={promptFg()}>{prompt()}</Text>
        </Box>
      </Box>

      {/* Directory */}
      <Box flexDirection="row">
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {`${t('tui.chrome.welcome.directory')} `}
        </Text>
        <Text fg={text()}>{props.workDir ?? ''}</Text>
      </Box>

      {/* Session */}
      <Box flexDirection="row">
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {`${t('tui.chrome.welcome.session')} `}
        </Text>
        <Text fg={text()}>{props.sessionId ?? ''}</Text>
      </Box>

      {/* Model */}
      <Box flexDirection="row">
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {`${t('tui.chrome.welcome.model')} `}
        </Text>
        <Text fg={text()}>{modelValue() ?? ''}</Text>
      </Box>

      {/* Version */}
      <Box flexDirection="row">
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {`${t('tui.chrome.welcome.version')} `}
        </Text>
        <Text fg={text()}>{props.version ?? ''}</Text>
      </Box>

      {/* MCP Servers summary */}
      <Show when={Boolean(props.mcpServersSummary && props.mcpServersSummary.length > 0)}>
        <Box flexDirection="row">
          <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
            {`${t('tui.chrome.welcome.mcp')} `}
          </Text>
          <Text fg={text()}>{props.mcpServersSummary ?? ''}</Text>
        </Box>
      </Show>
    </Box>
  )
}
