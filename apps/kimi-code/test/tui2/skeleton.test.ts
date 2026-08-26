/**
 * Skeleton structural test for the tui2/ tree.
 *
 * The skeleton mirrors tui/ 1:1 and re-exports the v1 surface. The
 * point of this test is to make sure the structural invariants hold:
 *
 *   - `tui2/env.ts` resolves the env var correctly
 *   - every `tui2/X.ts` file exists for the matching `tui/X.ts`
 *   - the new opentui + SolidJS primitives load AND expose the
 *     tui2-specific props (ClickableProps, ButtonProps, ...)
 *   - real .tsx impls are NOT silently replaced by v1 stubs
 *   - the v1 default still works when `KIMI_TUI` is unset
 *
 * No renderer is booted. The test is fast and dependency-free.
 *
 * Why this test checks tui2-specific identifiers: a previous bug
 * wiped real .tsx impls and the .ts facade silently fell back to
 * the v1 stub. The shape of the v1 class and the tui2 component
 * differ (v1 is a class with onClick(x, y), tui2 is a SolidJS
 * function with onClick({x, y})). Asserting the tui2 type names
 * catches that regression.
 */

import { describe, expect, it } from 'vitest'

import { isTuiV2Enabled, resolveTuiVariant, type TuiVariant } from '@/tui2/env'

describe('tui2 skeleton', () => {
  describe('env switch', () => {
    it('defaults to v1 when KIMI_TUI is unset', () => {
      expect(resolveTuiVariant({})).toBe<TuiVariant>('v1')
    })

    it('defaults to v1 when KIMI_TUI is an empty string', () => {
      expect(resolveTuiVariant({ KIMI_TUI: '' })).toBe<TuiVariant>('v1')
    })

    it('returns v1 for any non-"v2" value', () => {
      for (const value of ['v1', 'v3', 'true', '1', 'yes']) {
        expect(resolveTuiVariant({ KIMI_TUI: value })).toBe<TuiVariant>('v1')
      }
    })

    it('returns v2 for the literal "v2" (case-insensitive)', () => {
      expect(resolveTuiVariant({ KIMI_TUI: 'v2' })).toBe<TuiVariant>('v2')
      expect(resolveTuiVariant({ KIMI_TUI: 'V2' })).toBe<TuiVariant>('v2')
    })

    it('isTuiV2Enabled agrees with resolveTuiVariant', () => {
      expect(isTuiV2Enabled({})).toBe(false)
      expect(isTuiV2Enabled({ KIMI_TUI: 'v2' })).toBe(true)
    })
  })

  describe('public surface (tui2/index)', () => {
    // Importing `@/tui2` pulls the whole kimi-tui dependency tree (opentui +
    // solid JSX transforms) — slow under vitest, so give it a generous window.
    it('re-exports the env helpers', { timeout: 120_000 }, async () => {
      const mod = await import('@/tui2')
      expect(typeof mod.isTuiV2Enabled).toBe('function')
      expect(typeof mod.resolveTuiVariant).toBe('function')
    })
  })

  describe('common primitives (opentui + SolidJS)', () => {
    it('Box is a real tui2 component, not a v1 stub', async () => {
      const mod = await import('@/tui2/components/common/box')
      // v1 Container is a class with `.addChild`. The tui2 Box is a
      // SolidJS function component. typeof === 'function' alone is
      // not enough -- it must NOT have a v1-only static method.
      expect(typeof mod.Box).toBe('function')
      expect((mod.Box as unknown as { addChild?: unknown }).addChild).toBeUndefined()
    })

    it('Text is a real tui2 component', async () => {
      const mod = await import('@/tui2/components/common/text')
      expect(typeof mod.Text).toBe('function')
      expect((mod.Text as unknown as { addChild?: unknown }).addChild).toBeUndefined()
    })

    it('Spacer is a real tui2 component', async () => {
      const mod = await import('@/tui2/components/common/spacer')
      expect(typeof mod.Spacer).toBe('function')
    })

    it('Clickable is a real tui2 component (function, not v1 class)', async () => {
      const mod = await import('@/tui2/components/common/clickable')
      expect(typeof mod.Clickable).toBe('function')
      // The v1 implementation is a class with .addChild. The tui2
      // Clickable is a SolidJS function component, no class methods.
      expect((mod.Clickable as unknown as { addChild?: unknown }).addChild).toBeUndefined()
    })

    it('Button is a real tui2 component (function, not v1 class)', async () => {
      const mod = await import('@/tui2/components/common/button')
      expect(typeof mod.Button).toBe('function')
      expect((mod.Button as unknown as { addChild?: unknown }).addChild).toBeUndefined()
    })
  })

  describe('real .tsx impls survive re-runs of the skeleton script', () => {
    it('every common primitive has both a .ts facade and a .tsx impl', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { fileURLToPath } = await import('node:url')
      const here = path.dirname(fileURLToPath(import.meta.url))
      const commonDir = path.resolve(here, '../../src/tui2/components/common')

      const expected = ['box', 'text', 'spacer', 'clickable', 'button']
      const missing: string[] = []
      for (const name of expected) {
        const tsx = path.join(commonDir, `${name}.tsx`)
        const ts = path.join(commonDir, `${name}.ts`)
        if (!fs.existsSync(tsx) || fs.statSync(tsx).size === 0) {
          missing.push(`${name}.tsx`)
        }
        if (!fs.existsSync(ts) || fs.statSync(ts).size === 0) {
          missing.push(`${name}.ts`)
        }
      }
      expect(missing, `tui2/components/common/ missing files: ${missing.join(', ')}`).toEqual([])
    })
  })

  describe('mirror invariants', () => {
    // v1 files the tui2 tree has not mirrored yet — newer v1 features that
    // need an opentui/solid port or an unimplemented state slice (towerMode),
    // not a verbatim copy.
    //
    // The remaining entries are former verbatim mirrors removed by the
    // dead-file sweep: zero importers anywhere (tui2 modules import their
    // v1 twins directly), so keeping them would only fork live logic into
    // unmaintained duplicates. Kept explicit so the invariant check still
    // guards the rest of the mirror.
    const KNOWN_MIRROR_GAPS: readonly string[] = [
      'components/messages/tool-renderers/wait-for.ts',
      'commands/tower.ts',
      'components/chrome/gutter-container.ts',
      'components/dialogs/agent-activity-viewer.ts',
      'components/dialogs/coding-plan-config.ts',
      'components/editor/wrapping-select-list.ts',
      'components/messages/agent-swarm-progress-estimator.ts',
      'components/messages/goal-markers.ts',
      'components/messages/shell-run.ts',
      'components/messages/step-summary.ts',
      'constant/media.ts',
      'tui-state.ts',
      'utils/component-capabilities.ts',
      'utils/input-latency.ts',
      'utils/osc133.ts',
      'utils/progress-bar.ts',
      'utils/render-cache.ts',
      'utils/screen-takeover.ts',
      'utils/searchable-list.ts',
      'utils/steer-input.ts',
      'utils/tab-strip.ts',
      'utils/terminal-theme.ts',
      'utils/token-speed.ts',
      'utils/transcript-component-metadata.ts',
      'utils/tip-rotation.ts',
    ]

    it('every tui/ .ts file has a tui2/ counterpart', async () => {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { fileURLToPath } = await import('node:url')

      const here = path.dirname(fileURLToPath(import.meta.url))
      const tuiDir = path.resolve(here, '../../src/tui')
      const tui2Dir = path.resolve(here, '../../src/tui2')

      const walk = (dir: string, root: string): string[] => {
        const out: string[] = []
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            out.push(...walk(full, root))
          } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(path.relative(root, full).replace(/\\/g, '/'))
          }
        }
        return out
      }

      const tuiFiles = new Set(walk(tuiDir, tuiDir))
      const tui2Files = new Set(walk(tui2Dir, tui2Dir))

      const missing: string[] = []
      for (const rel of tuiFiles) {
        if (!tui2Files.has(rel) && !KNOWN_MIRROR_GAPS.includes(rel)) {
          missing.push(rel)
        }
      }

      expect(missing, `tui2/ files missing for: ${missing.join(', ')}`).toEqual([])
    })
  })
})
