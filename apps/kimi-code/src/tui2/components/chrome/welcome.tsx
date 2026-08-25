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
  let colorIndex = props.offset
  const spans = Array.from(props.text).map((char) => {
    if (char === ' ') return <Text>{char}</Text>
    const color = palette[colorIndex % palette.length] ?? palette[0]
    colorIndex++
    return (
      <Text fg={color} attributes={props.bold === true ? currentTheme.attributes('bold') : undefined}>
        {char}
      </Text>
    )
  })
  return <>{spans}</>
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
          {dancing() ? (
            <RainbowText text={LOGO[0]} offset={dancePhase()} />
          ) : (
            <Text fg={primary()}>{LOGO[0]}</Text>
          )}
          {dancing() ? (
            <RainbowText text={LOGO[1]} offset={dancePhase() + 3} />
          ) : (
            <Text fg={primary()}>{LOGO[1]}</Text>
          )}
        </Box>
        <Box flexDirection="column">
          {dancing() ? (
            <RainbowText text={DANCE_TITLE} offset={dancePhase() + 2} bold />
          ) : (
            <Text fg={textStrong()} attributes={currentTheme.attributes('bold')}>
              {t('tui.chrome.welcome.title')}
            </Text>
          )}
          <Text fg={promptFg()}>{prompt()}</Text>
        </Box>
      </Box>
      <Text fg={text()}>
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {t('tui.chrome.welcome.directory')}
        </Text>
        {props.workDir}
      </Text>
      <Text fg={text()}>
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {t('tui.chrome.welcome.session')}
        </Text>
        {props.sessionId}
      </Text>
      <Text fg={text()}>
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {t('tui.chrome.welcome.model')}
        </Text>
        {modelValue()}
      </Text>
      <Text fg={text()}>
        <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
          {t('tui.chrome.welcome.version')}
        </Text>
        {props.version}
      </Text>
      {props.mcpServersSummary !== null && props.mcpServersSummary.length > 0 ? (
        <Text fg={text()}>
          <Text fg={textDim()} attributes={currentTheme.attributes('bold')}>
            {t('tui.chrome.welcome.mcp')}
          </Text>
          {props.mcpServersSummary}
        </Text>
      ) : null}
    </Box>
  )
}
