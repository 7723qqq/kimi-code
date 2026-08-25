/** @jsxImportSource @opentui/solid */
/**
 * TUI2 plan box — renders an ExitPlanMode plan inside a full box border.
 *
 * Replaces `tui/components/messages/plan-box.ts`'s `PlanBoxComponent` (a
 * pi-tui `Component` that hand-painted the box rows with `chalk.hex`
 * strings) with an opentui SolidJS view. The border and the title inside
 * it are opentui box features; the plan body renders as markdown via
 * `MarkdownContentView`, so headings / lists / bold match the assistant
 * message appearance.
 *
 *   ┌─ plan: docs/AGENTS.md · approved ─┐
 *   │ <markdown plan body>              │
 *   └───────────────────────────────────┘
 *
 * The title logic stays pure (`buildPlanBoxTitle` / `buildStatusSuffix`,
 * mirrored from v1): `planPath` contributes a basename title, otherwise
 * the `tui.messages.planBox.fallback` label is used; an optional status
 * (label) is appended with ` · ` and the whole title is hard-capped at
 * {@link TITLE_MAX_CHARS}. v1 hyperlinked the basename (OSC 8) and
 * colored the status suffix separately — both are single-string
 * limitations of the opentui box title, so they are dropped here.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import path from 'node:path'

import type { Component } from 'solid-js'

import { t } from '#/i18n'

import { Box } from '../common/box'
import { MarkdownContentView } from './markdown-content'

/** Hard cap on the title; v1 truncated by width instead (layout-independent here). */
const TITLE_MAX_CHARS = 80

export interface PlanBoxStatus {
  readonly label: string
  readonly colorHex: string
}

export interface PlanBoxOptions {
  status?: PlanBoxStatus
}

export interface PlanBoxViewProps {
  readonly plan: string
  /** Border color (hex), matching v1's `borderHex` constructor arg. */
  readonly borderHex: string
  /** Plan file path — renders its basename in the title when present. */
  readonly planPath?: string
  readonly status?: PlanBoxStatus
}

/** ` · label` suffix for the title; empty when no status is set. */
export function buildStatusSuffix(status: PlanBoxStatus | undefined): string {
  if (status === undefined || status.label.length === 0) return ''
  return ` · ${status.label}`
}

/** Title line for the box border, mirrored from v1's `buildTitle`. */
export function buildPlanBoxTitle(planPath: string | undefined, status: PlanBoxStatus | undefined): string {
  const fallback = t('tui.messages.planBox.fallback')
  const fallbackWithStatus = `${fallback.trimEnd()}${buildStatusSuffix(status)} `
  if (planPath === undefined || planPath.length === 0) return fallbackWithStatus.trimEnd()
  const basename = path.basename(planPath)
  if (basename.length === 0) return fallbackWithStatus.trimEnd()
  const title = `${t('tui.messages.planBox.titlePrefix')}${basename}${buildStatusSuffix(status)} `
  return title.length > TITLE_MAX_CHARS ? `${title.slice(0, TITLE_MAX_CHARS)}…` : title
}

export const PlanBoxView: Component<PlanBoxViewProps> = (props) => {
  const title = (): string => buildPlanBoxTitle(props.planPath, props.status)

  return (
    <Box flexDirection="column" paddingLeft={2}>
      <Box
        border
        borderStyle="single"
        borderColor={props.borderHex}
        title={title()}
        titleColor={props.borderHex}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={1}
        paddingRight={1}
      >
        <MarkdownContentView content={props.plan.trim()} />
      </Box>
    </Box>
  )
}
