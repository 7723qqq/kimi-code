/** @jsxImportSource @opentui/solid */
/**
 * TUI2 usage panel — wraps `/usage`-style reports in a bordered box.
 *
 * Replaces `tui/components/messages/usage-panel.ts`'s
 * `UsagePanelComponent` (a pi-tui `Component` painting a `╭─╮` box with
 * chalk colours) with two surfaces:
 *
 *   - the line builders (`buildUsageReportLines` /
 *     `buildManagedUsageReportLines` / `buildExtraUsageSection`) now
 *     return *plain* text — the tui2 transcript stores plain content and
 *     opentui cannot render embedded ANSI. Column alignment and the
 *     progress bars are preserved; colour tokens are applied by views.
 *   - `UsagePanelComponent` keeps the v1 `render(width)` string API
 *     (used by `commands/info.ts` to render transcript entries) but
 *     paints plain box borders.
 *   - `UsagePanelView` is the opentui SolidJS box (real border + title,
 *     like `PlanBoxView`) for the transcript renderer; rows come in as
 *     children.
 *
 * Status: REAL (tui2). Replaces the v1 stub.
 */

import type { Component, JSX } from 'solid-js'
import { formatDuration } from '@moonshot-ai/kimi-code-oauth'
import type { SessionUsage, TokenUsage } from '@moonshot-ai/kimi-code-sdk'
import { truncateToWidth, visibleWidth } from '@moonshot-ai/pi-tui'

import { t } from '#/i18n'
import { currentTheme } from '../../theme'
import type { ColorToken } from '../../theme'
import {
  formatTokenCount,
  renderProgressBar,
  safeUsageRatio,
  usagePercent,
} from '#/utils/usage/usage-format'

import { Box } from '../common/box'

const LEFT_MARGIN = 2
const SIDE_PADDING = 1
const BOX_OVERHEAD = LEFT_MARGIN + 2 + 2 * SIDE_PADDING

type Colorize = (text: string) => string

export interface ManagedUsageWindow {
  readonly duration: number
  readonly unit: 'minute' | 'hour' | 'day' | 'week'
}

export interface ManagedUsageRow {
  readonly name?: string
  readonly window?: ManagedUsageWindow
  readonly used: number
  readonly limit: number
  readonly resetAt?: string
}

function usageRowLabel(row: ManagedUsageRow): string {
  const window = row.window
  if (window !== undefined) {
    if (window.unit === 'week') return 'Weekly limit'
    return `${String(window.duration)}${window.unit[0] ?? ''} limit`
  }
  return row.name ?? 'Limit'
}

function usageRowResetHint(row: ManagedUsageRow): string | undefined {
  const resetAt = row.resetAt
  if (resetAt === undefined) return undefined
  const parsed = Date.parse(resetAt)
  if (!Number.isFinite(parsed)) return undefined
  const diffSec = Math.floor((parsed - Date.now()) / 1000)
  if (diffSec <= 0) return 'reset'
  return `resets in ${formatDuration(diffSec)}`
}

export interface BoosterWalletInfo {
  readonly balanceCents: number
  readonly totalCents: number
  readonly monthlyChargeLimitEnabled: boolean
  readonly monthlyChargeLimitCents: number
  readonly monthlyUsedCents: number
  readonly currency: string
}

export interface ManagedUsageReport {
  readonly summary: ManagedUsageRow | null
  readonly limits: readonly ManagedUsageRow[]
  readonly extraUsage?: BoosterWalletInfo | null
}

export interface UsageReportOptions {
  readonly sessionUsage?: SessionUsage
  readonly sessionUsageError?: string
  readonly contextUsage: number
  readonly contextTokens: number
  readonly maxContextTokens: number
  readonly managedUsage?: ManagedUsageReport
  readonly managedUsageError?: string
}

export interface ManagedUsageReportLineOptions {
  readonly managedUsage?: ManagedUsageReport
  readonly managedUsageError?: string
}

function usageNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function usageInputTotal(usage: TokenUsage): number {
  return (
    usageNumber(usage.inputOther) +
    usageNumber(usage.inputCacheRead) +
    usageNumber(usage.inputCacheCreation)
  )
}

function buildSessionUsageSection(
  usage: SessionUsage | undefined,
  error: string | undefined,
): string[] {
  if (error !== undefined) return [`  ${error}`]
  const byModel = (usage as { readonly byModel?: Record<string, TokenUsage> } | undefined)?.byModel
  const entries = Object.entries(byModel ?? {})
  if (entries.length === 0) return [`  ${t('tui.messages.usagePanel.noTokenUsage')}`]

  const lines: string[] = []
  let totalInput = 0
  let totalOutput = 0
  for (const [model, row] of entries) {
    const input = usageInputTotal(row)
    const output = usageNumber(row.output)
    totalInput += input
    totalOutput += output
    lines.push(
      `  ${model}  ${t('tui.messages.usagePanel.input')} ${formatTokenCount(input)}  ${t('tui.messages.usagePanel.output')} ${formatTokenCount(output)}  ${t('tui.messages.usagePanel.total')} ${formatTokenCount(input + output)}`,
    )
  }
  if (entries.length > 1) {
    lines.push(
      `  ${t('tui.messages.usagePanel.total')}  ${t('tui.messages.usagePanel.input')} ${formatTokenCount(totalInput)}  ${t('tui.messages.usagePanel.output')} ${formatTokenCount(totalOutput)}  ${t('tui.messages.usagePanel.total')} ${formatTokenCount(totalInput + totalOutput)}`,
    )
  }
  return lines
}

function buildManagedUsageSection(
  usage: ManagedUsageReport | undefined,
  error: string | undefined,
): string[] {
  if (error !== undefined) return [t('tui.messages.usagePanel.planUsage'), `  ${error}`]
  if (usage === undefined) return []
  const { summary, limits } = usage
  if (summary === null && limits.length === 0) {
    return [t('tui.messages.usagePanel.planUsage'), `  ${t('tui.messages.usagePanel.noUsageData')}`]
  }

  const rows: ManagedUsageRow[] = []
  if (summary !== null) rows.push(summary)
  rows.push(...limits)
  const usedRatio = (r: ManagedUsageRow): number =>
    r.limit > 0 ? Math.max(0, Math.min(r.used / r.limit, 1)) : 0
  const labels = rows.map((r) => usageRowLabel(r))
  const labelWidth = Math.max(10, ...labels.map((l) => l.length))
  const pctWidth = Math.max(...rows.map((r) => `${Math.round(usedRatio(r) * 100)}% used`.length))

  const out: string[] = [t('tui.messages.usagePanel.planUsage')]
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!
    const ratioUsed = usedRatio(row)
    const bar = renderProgressBar(ratioUsed, 20)
    const pct = `${Math.round(ratioUsed * 100)}% used`
    const label = labels[i]!.padEnd(labelWidth, ' ')
    const resetHint = usageRowResetHint(row)
    const resetStr = resetHint !== undefined ? `  ${resetHint}` : ''
    out.push(`  ${label}  ${bar}  ${pct.padEnd(pctWidth, ' ')}${resetStr}`)
  }
  return out
}

function currencySymbol(currency: string): string {
  switch (currency.toUpperCase()) {
    case 'CNY':
      return '¥'
    case 'USD':
      return '$'
    default:
      return ''
  }
}

interface CurrencyParts {
  readonly symbol: string
  readonly number: string
}

function formatCurrencyParts(cents: number, currency: string): CurrencyParts {
  const symbol = currencySymbol(currency)
  const main = cents / 100
  const formatted = main.toFixed(2)
  return symbol.length > 0
    ? { symbol, number: formatted }
    : { symbol: '', number: `${formatted} ${currency}` }
}

/**
 * Plain `extra usage` section lines. The v1 signature carried `Colorize`
 * lambdas; they are kept as optional identity defaults so the exported
 * name and call shape stay compatible.
 */
export function buildExtraUsageSection(
  extraUsage: BoosterWalletInfo | undefined | null,
  _accent?: Colorize,
  _value?: Colorize,
  _muted?: Colorize,
): string[] {
  if (extraUsage === undefined || extraUsage === null) return []

  const hasMonthlyLimit =
    extraUsage.monthlyChargeLimitEnabled && extraUsage.monthlyChargeLimitCents > 0

  const balance = formatCurrencyParts(extraUsage.balanceCents, extraUsage.currency)
  const used = formatCurrencyParts(extraUsage.monthlyUsedCents, extraUsage.currency)
  const rows: Array<{ label: string; symbol: string; number: string }> = []
  let barLine: string | null = null

  if (hasMonthlyLimit) {
    const ratio = Math.max(
      0,
      Math.min(extraUsage.monthlyUsedCents / extraUsage.monthlyChargeLimitCents, 1),
    )
    const bar = renderProgressBar(ratio, 20)
    barLine = `  ${bar}`
    const limit = formatCurrencyParts(extraUsage.monthlyChargeLimitCents, extraUsage.currency)
    rows.push({ label: t('tui.messages.usagePanel.usedThisMonth'), ...used })
    rows.push({ label: t('tui.messages.usagePanel.monthlyLimit'), ...limit })
    rows.push({ label: t('tui.messages.usagePanel.balance'), ...balance })
  } else {
    rows.push({ label: t('tui.messages.usagePanel.usedThisMonth'), ...used })
    rows.push({
      label: t('tui.messages.usagePanel.monthlyLimit'),
      symbol: '',
      number: t('tui.messages.usagePanel.unlimited'),
    })
    rows.push({ label: t('tui.messages.usagePanel.balance'), ...balance })
  }

  // `Used this month` is the longest label; size the column to the widest label
  // so the currency symbol starts in the same column on every row.
  const labelWidth = Math.max(...rows.map((r) => r.label.length))
  // Right-align the numeric part of currency rows against each other so the
  // decimal points line up (e.g. `¥ 50.00` / `¥200.00`). Text-only rows such as
  // `Unlimited` carry no currency symbol, so they must not widen the numeric
  // column — otherwise money values get padded with stray spaces.
  const numberWidth = Math.max(
    0,
    ...rows.filter((r) => r.symbol.length > 0).map((r) => visibleWidth(r.number)),
  )
  const row = (label: string, symbol: string, number: string): string => {
    const cell = symbol.length > 0 ? symbol + number.padStart(numberWidth, ' ') : number
    return `  ${label.padEnd(labelWidth, ' ')}  ${cell}`
  }

  const lines: string[] = [t('tui.messages.usagePanel.extraUsage')]
  if (barLine !== null) lines.push(barLine)
  for (const r of rows) lines.push(row(r.label, r.symbol, r.number))

  return lines
}

export function buildManagedUsageReportLines(options: ManagedUsageReportLineOptions): string[] {
  return buildManagedUsageSection(options.managedUsage, options.managedUsageError)
}

export function buildUsageReportLines(options: UsageReportOptions): string[] {
  const lines: string[] = [
    t('tui.messages.usagePanel.sessionUsage'),
    ...buildSessionUsageSection(options.sessionUsage, options.sessionUsageError),
  ]

  if (options.maxContextTokens > 0) {
    const ratio = safeUsageRatio(options.contextUsage)
    const bar = renderProgressBar(ratio, 20)
    const pct = `${String(usagePercent(options.contextTokens, options.maxContextTokens))}%`
    lines.push('')
    lines.push(t('tui.messages.usagePanel.contextWindow'))
    lines.push(
      `  ${bar}  ${pct.padStart(6, ' ')}  ` +
        `(${formatTokenCount(options.contextTokens)} / ${formatTokenCount(
          options.maxContextTokens,
        )})`,
    )
  }

  const managedSection = buildManagedUsageReportLines({
    managedUsage: options.managedUsage,
    managedUsageError: options.managedUsageError,
  })
  if (managedSection.length > 0) {
    lines.push('')
    lines.push(...managedSection)
  }

  const extraSection = buildExtraUsageSection(options.managedUsage?.extraUsage)
  if (extraSection.length > 0) {
    lines.push('')
    lines.push(...extraSection)
  }

  return lines
}

/**
 * String-box renderer kept for `commands/info.ts`'s transcript panels:
 * `new UsagePanelComponent(buildLines, borderToken, title).render(width)`
 * returns plain boxed lines (colours are dropped — the tui2 transcript
 * stores plain content; `UsagePanelView` provides the coloured box for
 * the renderer).
 */
export class UsagePanelComponent {
  /** Cached lines; rebuilt from `buildLines` on every render. */
  private lines: readonly string[]

  constructor(
    private readonly buildLines: () => readonly string[],
    private readonly borderToken: ColorToken,
    private readonly title: string = t('tui.messages.usagePanel.title'),
  ) {
    this.lines = buildLines()
  }

  invalidate(): void {
    this.lines = this.buildLines()
  }

  render(width: number): string[] {
    const safeWidth = Math.max(0, width)
    if (safeWidth <= 0) return ['']

    const availableInterior = safeWidth - BOX_OVERHEAD
    if (availableInterior < 1) {
      return [
        truncateToWidth(this.title.trim(), safeWidth, '…'),
        ...this.lines.map((line) => truncateToWidth(line, safeWidth, '…')),
      ]
    }

    const indent = ' '.repeat(LEFT_MARGIN)
    const longestLine = this.lines.reduce((max, line) => Math.max(max, visibleWidth(line)), 0)
    const contentWidth = Math.max(
      1,
      Math.min(availableInterior, Math.max(longestLine, visibleWidth(this.title))),
    )
    const horzLen = contentWidth + 2 * SIDE_PADDING
    const title = truncateToWidth(this.title, horzLen, '…')

    const trailingDashLen = Math.max(0, horzLen - visibleWidth(title))
    const top = `${indent}╭${title}${'─'.repeat(trailingDashLen)}╮`
    const bottom = `${indent}╰${'─'.repeat(horzLen)}╯`

    const out: string[] = [top]
    for (const line of this.lines) {
      const clipped = visibleWidth(line) > contentWidth ? truncateToWidth(line, contentWidth) : line
      const pad = Math.max(0, contentWidth - visibleWidth(clipped))
      out.push(`${indent}│ ${clipped}${' '.repeat(pad)} │`)
    }
    out.push(bottom)
    return out.map((line) => truncateToWidth(line, safeWidth, '…'))
  }
}

export interface UsagePanelViewProps {
  readonly title: string
  readonly borderToken: ColorToken
  /** Report rows; callers render plain or token-coloured lines. */
  readonly children: JSX.Element
}

/** opentui bordered box for the transcript renderer (mirrors PlanBoxView). */
export const UsagePanelView: Component<UsagePanelViewProps> = (props) => {
  return (
    <Box flexDirection="column" paddingLeft={LEFT_MARGIN}>
      <Box
        border
        borderStyle="single"
        borderColor={currentTheme.color(props.borderToken)}
        title={` ${props.title} `}
        titleColor={currentTheme.color(props.borderToken)}
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={SIDE_PADDING + 1}
        paddingRight={SIDE_PADDING + 1}
      >
        <Box flexDirection="column">{props.children}</Box>
      </Box>
    </Box>
  )
}
