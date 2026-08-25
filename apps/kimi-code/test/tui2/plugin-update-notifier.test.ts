/**
 * Tests for `PluginUpdateNotifier` — the one-time "update detected" notifier
 * for outdated plugins.
 *
 * The notifier is pure logic with injected dependencies (session accessor,
 * marketplace loader, notice-state file, notify callback), so it is tested
 * against a fiducial mock session + an in-memory file path. These tests pin
 * the resolution (MCP tool name → plugin id), the marketplace/install-source
 * guards, the version-based one-time notice semantics, and the serialized
 * read-modify-write cycle on the persisted notice state.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PluginSummary } from '@moonshot-ai/kimi-code-sdk'

import {
  isPluginMcpToolName,
  PluginUpdateNotifier,
  type PluginUpdateNotifierSession,
} from '@/tui2/controllers/plugin-update-notifier'
import { writePluginUpdateNoticeState, readPluginUpdateNoticeState } from '@/utils/plugin-update-notice-state'
import type { PluginMarketplace } from '@/utils/plugin-marketplace'

const OFFICIAL_MARKETPLACE_URL = 'https://code.kimi.com/kimi-code/plugins/marketplace.json'

function makeOfficialPlugin(id: string, version: string): PluginSummary {
  return {
    id,
    displayName: 'Hello World',
    version,
    enabled: true,
    state: 'enabled',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'zip-url',
    originalSource: `https://code.kimi.com/kimi-code/plugins/official/${id}.zip`,
  } as unknown as PluginSummary
}

function makeLocalPlugin(id: string, version: string): PluginSummary {
  return {
    id,
    displayName: 'Hello World',
    version,
    enabled: true,
    state: 'enabled',
    skillCount: 0,
    mcpServerCount: 0,
    enabledMcpServerCount: 0,
    hookCount: 0,
    commandCount: 0,
    hasErrors: false,
    source: 'github',
    originalSource: 'https://github.com/example/hello-world',
  } as unknown as PluginSummary
}

function defaultMarketplace(): PluginMarketplace {
  return {
    source: OFFICIAL_MARKETPLACE_URL,
    plugins: [{ id: 'hello-world', displayName: 'Hello World', source: 'official', version: '1.1.0' }],
  }
}

interface Harness {
  readonly notifier: PluginUpdateNotifier
  readonly notify: ReturnType<typeof vi.fn>
  readonly listMcpServers: ReturnType<typeof vi.fn>
  readonly listPlugins: ReturnType<typeof vi.fn>
  readonly stateFile: string
  readonly tempDir: string
}

const tempDirs: string[] = []

async function setupHarness(opts?: {
  noSession?: boolean
  marketplace?: PluginMarketplace | undefined
  marketplaceError?: unknown
  installedPlugins?: readonly PluginSummary[]
  mcpServerNames?: readonly string[]
}): Promise<Harness> {
  const tempDir = await mkdtemp(join(tmpdir(), 'kimi-tui2-notifier-'))
  tempDirs.push(tempDir)
  const stateFile = join(tempDir, 'state', 'notice.json')

  const notify = vi.fn()
  const listMcpServers = vi.fn(
    async (): Promise<readonly { name: string }[]> =>
      (opts?.mcpServerNames ?? ['plugin-hello-world:filesystem', 'regular-server']).map((name) => ({
        name,
      })),
  )
  const listPlugins = vi.fn(
    async (): Promise<readonly PluginSummary[]> =>
      opts?.installedPlugins ?? [makeOfficialPlugin('hello-world', '1.0.0')],
  )
  const session: PluginUpdateNotifierSession | undefined = opts?.noSession
    ? undefined
    : { listMcpServers, listPlugins }
  const loadMarketplace = vi.fn(async (): Promise<PluginMarketplace> => {
    if (opts?.marketplaceError !== undefined) throw opts.marketplaceError
    return opts?.marketplace ?? defaultMarketplace()
  })

  const notifier = new PluginUpdateNotifier({
    getSession: () => session,
    workDir: process.cwd(),
    notify,
    loadMarketplace,
    stateFile,
  })

  return { notifier, notify, listMcpServers, listPlugins, stateFile, tempDir }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('isPluginMcpToolName', () => {
  it('recognizes the plugin MCP tool prefix', () => {
    expect(isPluginMcpToolName('mcp__plugin-hello-world__foo')).toBe(true)
    expect(isPluginMcpToolName('mcp__plugin-x__tools_read')).toBe(true)
  })

  it('rejects non-plugin tool names', () => {
    expect(isPluginMcpToolName('Bash')).toBe(false)
    expect(isPluginMcpToolName('mcp__github__repo')).toBe(false)
    expect(isPluginMcpToolName('mcp__pluginx')).toBe(false)
  })
})

describe('PluginUpdateNotifier.handleMcpToolCompleted', () => {
  it('bails before touching the RPC layer for non-MCP tools', async () => {
    const h = await setupHarness()
    await h.notifier.handleMcpToolCompleted('Bash')
    expect(h.listMcpServers).not.toHaveBeenCalled()
    expect(h.listPlugins).not.toHaveBeenCalled()
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('resolves the plugin id from the MCP server runtime name and notifies', async () => {
    const h = await setupHarness()
    await h.notifier.handleMcpToolCompleted('mcp__plugin-hello-world_filesystem__read_file')

    expect(h.notify).toHaveBeenCalledTimes(1)
    expect(String(h.notify.mock.calls[0]?.[0])).toContain('Hello World')
    expect(String(h.notify.mock.calls[0]?.[0])).toContain('1.1.0')
  })

  it('refreshes the server map once on a miss for later-installed plugins', async () => {
    const h = await setupHarness()
    // First tool resolves against a cold map; a second tool for the same
    // plugin hits the memoized map (single listMcpServers call).
    await h.notifier.handleMcpToolCompleted('mcp__plugin-hello-world_filesystem__a')
    await h.notifier.handleMcpToolCompleted('mcp__plugin-hello-world_filesystem__b')
    expect(h.listMcpServers).toHaveBeenCalledTimes(1)
    expect(h.notify).toHaveBeenCalled()
  })

  it('swallows an unresolved tool name silently', async () => {
    const h = await setupHarness()
    await h.notifier.handleMcpToolCompleted('mcp__plugin-nope_filesystem__read')
    expect(h.notify).not.toHaveBeenCalled()
  })
})

describe('PluginUpdateNotifier.checkAndNotify guards', () => {
  it('does nothing without a session', async () => {
    const h = await setupHarness({ noSession: true })
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('does nothing when the marketplace is not the official catalog', async () => {
    const h = await setupHarness({
      marketplace: { source: 'https://example.com/custom.json', plugins: [{ id: 'hello-world', displayName: 'Hello World', source: 'custom', version: '9.0.0' }] },
    })
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('does nothing when the plugin is absent from the marketplace', async () => {
    const h = await setupHarness({ marketplace: { source: OFFICIAL_MARKETPLACE_URL, plugins: [] } })
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('does nothing when the plugin is not installed', async () => {
    const h = await setupHarness({ installedPlugins: [] })
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('does nothing for a local/GitHub fork sharing the catalog id', async () => {
    const h = await setupHarness({ installedPlugins: [makeLocalPlugin('hello-world', '1.0.0')] })
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('does nothing when the installed version is up to date', async () => {
    const h = await setupHarness({ installedPlugins: [makeOfficialPlugin('hello-world', '1.1.0')] })
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).not.toHaveBeenCalled()
  })

  it('swallows a marketplace load failure', async () => {
    const h = await setupHarness({ marketplaceError: new Error('offline') })
    await expect(h.notifier.handlePluginCommandCompleted('hello-world')).resolves.toBeUndefined()
    expect(h.notify).not.toHaveBeenCalled()
  })
})

describe('PluginUpdateNotifier one-time notice semantics', () => {
  it('notifies once and persists the notified version', async () => {
    const h = await setupHarness()
    await h.notifier.handlePluginCommandCompleted('hello-world')
    expect(h.notify).toHaveBeenCalledTimes(1)

    // The notice state file now records the notified version.
    const state = await readPluginUpdateNoticeState(h.stateFile)
    expect(state.notified['hello-world']).toBe('1.1.0')
  })

  it('does not re-notify a version already shown', async () => {
    const h = await setupHarness()
    await writePluginUpdateNoticeState(
      { version: 1, notified: { 'hello-world': '1.1.0' } },
      h.stateFile,
    )

    await h.notifier.handlePluginCommandCompleted('hello-world')

    expect(h.notify).not.toHaveBeenCalled()
  })

  it('re-notifies when the marketplace advertises a newer version than shown', async () => {
    const h = await setupHarness()
    await writePluginUpdateNoticeState(
      { version: 1, notified: { 'hello-world': '1.0.5' } },
      h.stateFile,
    )

    await h.notifier.handlePluginCommandCompleted('hello-world')

    expect(h.notify).toHaveBeenCalledTimes(1)
  })

  it('serializes concurrent checks so both plugins are notified', async () => {
    const h = await setupHarness({
      marketplace: {
        source: OFFICIAL_MARKETPLACE_URL,
        plugins: [
          { id: 'hello-world', displayName: 'Hello World', source: 'official', version: '1.1.0' },
          { id: 'alpha', displayName: 'Alpha', source: 'official', version: '2.0.0' },
        ],
      },
      installedPlugins: [
        makeOfficialPlugin('hello-world', '1.0.0'),
        makeOfficialPlugin('alpha', '1.0.0'),
      ],
    })

    await Promise.all([
      h.notifier.handlePluginCommandCompleted('hello-world'),
      h.notifier.handlePluginCommandCompleted('alpha'),
    ])

    expect(h.notify).toHaveBeenCalledTimes(2)
  })
})
