/**
 * Skeleton structural test for the tui2/ tree.
 *
 * The skeleton mirrors tui/ 1:1 and re-exports the v1 surface. The
 * point of this test is to make sure the structural invariants hold:
 *
 *   - `tui2/env.ts` resolves the env var correctly
 *   - every `tui2/X.ts` file exists for the matching `tui/X.ts`
 *   - the new opentui + SolidJS primitives load and have JSX
 *   - the v1 default still works when `KIMI_TUI` is unset
 *
 * No renderer is booted. The test is fast and dependency-free.
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
    // The dynamic import of '@/tui2' pulls in the whole skeleton
    // (222 re-export stubs), each of which re-exports from tui/. On
    // cold start this can take a few seconds. Give it 30s.
    it('re-exports the env helpers', { timeout: 30_000 }, async () => {
      const mod = await import('@/tui2')
      // The env helpers are part of the public surface.
      expect(typeof mod.isTuiV2Enabled).toBe('function')
      expect(typeof mod.resolveTuiVariant).toBe('function')
    })
  })

  describe('common primitives (opentui + SolidJS)', () => {
    it('loads Box without throwing', async () => {
      const mod = await import('@/tui2/components/common/box')
      expect(typeof mod.Box).toBe('function')
    })

    it('loads Text without throwing', async () => {
      const mod = await import('@/tui2/components/common/text')
      expect(typeof mod.Text).toBe('function')
    })

    it('loads Spacer without throwing', async () => {
      const mod = await import('@/tui2/components/common/spacer')
      expect(typeof mod.Spacer).toBe('function')
    })

    it('loads Clickable without throwing', async () => {
      const mod = await import('@/tui2/components/common/clickable')
      expect(typeof mod.Clickable).toBe('function')
    })

    it('loads Button without throwing', async () => {
      const mod = await import('@/tui2/components/common/button')
      expect(typeof mod.Button).toBe('function')
    })
  })

  describe('mirror invariants', () => {
    it('every tui/ .ts file has a tui2/ counterpart', async () => {
      // Static list to keep the test fast and avoid recursive fs walks.
      // The list is generated from the `find` of `tui/` at skeleton
      // creation time; if a new file lands in tui/ without a tui2/
      // counterpart, regenerate this list (see scripts/create-tui2-skeleton.ps1).
      const fs = await import('node:fs')
      const path = await import('node:path')
      const { fileURLToPath } = await import('node:url')

      const here = path.dirname(fileURLToPath(import.meta.url))
      const tuiDir = path.resolve(here, '../../src/tui')
      const tui2Dir = path.resolve(here, '../../src/tui2')

      const walk = (dir: string): string[] => {
        const out: string[] = []
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name)
          if (entry.isDirectory()) {
            out.push(...walk(full))
          } else if (entry.isFile() && entry.name.endsWith('.ts')) {
            out.push(path.relative(dir, full).replace(/\\/g, '/'))
          }
        }
        return out
      }

      const tuiFiles = new Set(walk(tuiDir))
      const tui2Files = new Set(walk(tui2Dir))

      const missing: string[] = []
      for (const rel of tuiFiles) {
        if (!tui2Files.has(rel)) {
          missing.push(rel)
        }
      }

      expect(missing, `tui2/ files missing for: ${missing.join(', ')}`).toEqual([])
    })
  })
})
