import { describe, expect, test } from 'bun:test';

import {
  BEHAVIOR_CONTRACT_CLAUSES,
  CORE_BEHAVIOR_CONTRACT_IDS,
} from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract';
import { DEEPSEEK_ADAPTATION_SOURCE_ID } from '../../../packages/agent-core-v2/src/app/agentProfileCatalog/modelAdaptations';
import {
  AUTHORIZED_ACTUAL_GLOBAL_PATH,
  DEFAULT_FIXTURE_AGENTS_MD,
  RenderedPromptError,
  benchmarkFixture,
  contractCoverageFor,
  contractCoverageGaps,
  normalizeAuthorizedPath,
  renderProfile,
  type RenderFixture,
} from '../src/rendered-prompt';

const FULL_MODEL = 'kimi-k3-1';
const MINIMAL_MODEL = 'deepseek-v4-pro';

const fixture: RenderFixture = {
  cwd: '/tmp/repo',
  agentsMd: '# Project instructions\n\nPrefer bun over npm.',
  osKind: 'Linux',
  shellName: 'Bash',
  shellPath: '/bin/bash',
  skills: '- project:run-tests — runs the suite',
  pluginSections: 'Plugin says: be terse.',
  additionalDirsInfo: '/tmp/shared',
  notifyUserActive: true,
};

async function codeOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof RenderedPromptError) return error.code;
    throw error;
  }
  throw new Error('expected a RenderedPromptError, but the render succeeded');
}

describe('full profile', () => {
  test('renders every template variable and leaves no placeholder behind', async () => {
    const rendered = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    expect(rendered.system).not.toContain('${');
    expect(rendered.warnings).toEqual([]);
    expect(rendered.system).toContain('/tmp/repo');
    expect(rendered.system).toContain('Prefer bun over npm.');
    expect(rendered.system).toContain('Bash');
    // The kimi model has no curated family guidance, so no adaptation block is
    // embedded; a family that has one is covered by the adapted-model block.
    expect(rendered.reminderSourceId).toBeUndefined();
  });

  test('delivers all six core contracts in the system text', async () => {
    const rendered = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    const channels = new Map(rendered.contractDelivery.map((e) => [e.id, e.channel]));
    for (const id of CORE_BEHAVIOR_CONTRACT_IDS) {
      expect(channels.get(id)).toBe('system');
    }
    expect(rendered.contractDelivery).toHaveLength(CORE_BEHAVIOR_CONTRACT_IDS.length);
    // The delivery record claims the clause; the text has to carry it.
    for (const clause of BEHAVIOR_CONTRACT_CLAUSES) {
      expect(rendered.system).toContain(clause.full);
    }
    const coverage = contractCoverageFor(rendered.contractDelivery, { reminderPresent: false });
    expect(contractCoverageGaps(coverage)).toEqual([]);
  });
});

describe('a family-adapted model', () => {
  // Every model family renders the same `system.md`, so a DeepSeek run is not a
  // different prompt shape: its curated guidance arrives through
  // `${model_adaptation_section}` inside the one system text, and all six core
  // contracts arrive there too. There is no reminder channel to measure.
  test('renders the one system prompt with the family guidance embedded', async () => {
    const rendered = await renderProfile({ profile: 'full', model: MINIMAL_MODEL, fixture });
    expect(rendered.system).not.toContain('${');
    expect(rendered.reminderSourceId).toBe(DEEPSEEK_ADAPTATION_SOURCE_ID);
    expect(rendered.system).toContain('# Model Adaptation: ' + MINIMAL_MODEL);
    expect(rendered.system).toContain('Curated guidance for this model family');
  });

  test('delivers every core contract through the system text, none through a reminder', async () => {
    const rendered = await renderProfile({ profile: 'full', model: MINIMAL_MODEL, fixture });
    const byChannel = (channel: string) =>
      rendered.contractDelivery.filter((entry) => entry.channel === channel).map((entry) => entry.id);
    expect(byChannel('system')).toEqual([...CORE_BEHAVIOR_CONTRACT_IDS]);
    expect(byChannel('reminder')).toEqual([]);
    expect(byChannel('intentionally_omitted')).toEqual([]);

    const coverage = contractCoverageFor(rendered.contractDelivery, { reminderPresent: false });
    expect(contractCoverageGaps(coverage)).toEqual([]);
  });

  test('a claimed reminder with no reminder text is a gap, not coverage', () => {
    const coverage = contractCoverageFor(
      [
        { id: 'authority_and_untrusted_content', channel: 'system' },
        { id: 'communication', channel: 'reminder' },
      ],
      { reminderPresent: false },
    );
    expect(contractCoverageGaps(coverage)).toContain('communication');
    expect(coverage['communication']!.omitted).toBe(1);
  });

  test('a claimed reminder counts only when reminder text is present', () => {
    const delivery = [{ id: 'communication', channel: 'reminder' }] as const;
    expect(contractCoverageFor(delivery, { reminderPresent: false })['communication']!.omitted).toBe(1);
    expect(contractCoverageFor(delivery, { reminderPresent: true })['communication']!.reminder).toBe(1);
  });
});

describe('the profile is the only one, and unknown ones are refused', () => {
  test('a retired profile name is refused rather than silently rendering full', async () => {
    // `minimal` and `deepseek-adapted` used to be real profile shapes. Rendering
    // `full` under those names would make a report claim a prompt nobody receives.
    for (const profile of ['minimal', 'deepseek-adapted'] as const) {
      expect(await codeOf(() => renderProfile({ profile, model: FULL_MODEL, fixture }))).toBe(
        'unknown_profile',
      );
    }
  });

  test('the refusal names the profile and lists what is legal', async () => {
    const error = await renderProfile({
      profile: 'minimal',
      model: MINIMAL_MODEL,
      fixture,
    }).catch((e: unknown) => e as RenderedPromptError);
    expect(error).toBeInstanceOf(RenderedPromptError);
    expect(error.message).toContain('minimal');
    expect(error.message).toContain('full');
  });
});

describe('fixture completeness', () => {
  test('a fixture without a cwd is refused', async () => {
    expect(await codeOf(() => renderProfile({ profile: 'full', model: FULL_MODEL, fixture: { cwd: '' } }))).toBe(
      'fixture_incomplete',
    );
  });

  test('an omitted agents.md is recorded as none rather than invented', async () => {
    const rendered = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture: { cwd: '/tmp/repo', osKind: 'Linux' },
    });
    expect(rendered.fixtureSummary.agentsMd).toBe('none');
    expect(rendered.fixtureSummary.agentsMdChars).toBe(0);
  });
});

describe('the authorized actual-global opt-in', () => {
  test('any path other than the one authorized constant is refused, without reading it', async () => {
    expect(
      await codeOf(() =>
        renderProfile({
          profile: 'full',
          model: FULL_MODEL,
          fixture,
          actualGlobalPath: 'C:/Users/Administrator/.kimi-code/other.md',
        }),
      ),
    ).toBe('actual_global_path_rejected');

    expect(
      await codeOf(() =>
        renderProfile({
          profile: 'full',
          model: FULL_MODEL,
          fixture,
          actualGlobalPath: 'C:/Users/Administrator/.kimi-code/AGENTS.md.bak',
        }),
      ),
    ).toBe('actual_global_path_rejected');
  });

  test('the authorized path is accepted through a normalized comparison', () => {
    const backslashed = AUTHORIZED_ACTUAL_GLOBAL_PATH.replaceAll('/', '\\').toUpperCase();
    expect(normalizeAuthorizedPath(backslashed)).toBe(normalizeAuthorizedPath(AUTHORIZED_ACTUAL_GLOBAL_PATH));
    expect(normalizeAuthorizedPath('C:/Users/Administrator/.kimi-code/AGENTS.md ')).toBe(
      normalizeAuthorizedPath(AUTHORIZED_ACTUAL_GLOBAL_PATH),
    );
  });

  test('the authorized path renders from an injected reader and keeps its content out of the summary', async () => {
    const marker = 'GLOBAL-INSTRUCTION-MARKER-7f31';
    const rendered = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture,
      actualGlobalPath: AUTHORIZED_ACTUAL_GLOBAL_PATH,
      readActualGlobal: async (path) => {
        expect(path).toBe(AUTHORIZED_ACTUAL_GLOBAL_PATH);
        return `# Global rules\n\n${marker}`;
      },
    });

    // The content reaches the prompt…
    expect(rendered.system).toContain(marker);
    // …and nothing but its provenance and size reaches the summary.
    expect(rendered.fixtureSummary.agentsMd).toBe('actual');
    expect(rendered.fixtureSummary.agentsMdChars).toBe('# Global rules\n\n'.length + marker.length);
    const summary = JSON.stringify(rendered.fixtureSummary);
    expect(summary).not.toContain(marker);
    expect(summary).not.toContain('Global rules');
  });

  test('an unreadable authorized file is a named error that carries no content', async () => {
    const error = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture,
      actualGlobalPath: AUTHORIZED_ACTUAL_GLOBAL_PATH,
      readActualGlobal: async () => {
        throw Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });
      },
    }).catch((e: unknown) => e as RenderedPromptError);
    expect(error).toBeInstanceOf(RenderedPromptError);
    expect(error.code).toBe('actual_global_unreadable');
    expect(error.message).toContain('ENOENT');
    expect(error.message).not.toContain('Global');
  });
});

describe('the reportable fingerprint', () => {
  test('the source hash is a stable 16-character hex digest of the rendered parts', async () => {
    const first = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    const second = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    expect(first.sourceHash).toMatch(/^[0-9a-f]{16}$/);
    expect(second.sourceHash).toBe(first.sourceHash);
  });

  test('a different profile or a different fixture changes the hash', async () => {
    const full = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    const other = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture: { ...fixture, cwd: '/tmp/other-repo' },
    });
    expect(other.sourceHash).not.toBe(full.sourceHash);
  });

  test('the fixture summary reports presence and size, never text', async () => {
    const rendered = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    const summary = rendered.fixtureSummary;
    expect(summary.agentsMd).toBe('fixture');
    expect(summary.plugins).toBe(true);
    expect(summary.skillsChars).toBe(fixture.skills!.length);
    expect(summary.pluginChars).toBe(fixture.pluginSections!.length);
    expect(summary.additionalDirsChars).toBe(fixture.additionalDirsInfo!.length);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('Prefer bun over npm');
    expect(serialized).not.toContain('be terse');
    expect(serialized).not.toContain('/tmp/shared');
  });
});

describe('the default benchmark fixture', () => {
  // Regression guard: the repository's own AGENTS.md explains the injection by
  // quoting `${agents_md}`, which the renderer's unresolved-variable scan then
  // reports — so benchmarking that file marked every run as unavailable before
  // the prompt had been measured at all.
  test('renders the one profile with no warning and no placeholder', async () => {
    const rendered = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture: benchmarkFixture('/tmp/repo', 'linux'),
    });
    expect(rendered.warnings).toEqual([]);
    expect(rendered.system).not.toContain('${');
    expect(rendered.fixtureSummary.agentsMd).toBe('fixture');
  });

  test('the fixture text itself contains no template placeholder', () => {
    expect(DEFAULT_FIXTURE_AGENTS_MD).not.toContain('${');
    expect(DEFAULT_FIXTURE_AGENTS_MD.length).toBeGreaterThan(0);
  });

  test('the fixture is stable across calls, so two runs stay comparable', async () => {
    const first = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture: benchmarkFixture('/tmp/repo', 'linux'),
    });
    const second = await renderProfile({
      profile: 'full',
      model: FULL_MODEL,
      fixture: benchmarkFixture('/tmp/repo', 'linux'),
    });
    expect(second.sourceHash).toBe(first.sourceHash);
  });
});
