import { describe, expect, test } from 'bun:test';

import {
  BEHAVIOR_CONTRACT_CLAUSES,
  CORE_BEHAVIOR_CONTRACT_IDS,
  MINIMAL_CONTRACT_HANDOFF,
  behaviorContractClause,
  type CoreBehaviorContractId,
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

const DELEGATED: readonly CoreBehaviorContractId[] = [
  'tools_and_repository_context',
  'safety_and_scope',
  'failure_and_partial_progress',
  'communication',
];

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
    expect(rendered.reminder).toBeUndefined();
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

describe('deepseek-adapted profile', () => {
  test('hands the delegated rules off in the system text and carries them in the reminder', async () => {
    const rendered = await renderProfile({ profile: 'deepseek-adapted', model: MINIMAL_MODEL, fixture });
    expect(rendered.system).not.toContain('${');
    expect(rendered.system).toContain(MINIMAL_CONTRACT_HANDOFF);

    const reminder = rendered.reminder ?? '';
    expect(reminder.length).toBeGreaterThan(0);
    expect(rendered.reminderSourceId).toBe(DEEPSEEK_ADAPTATION_SOURCE_ID);
    expect(reminder).toContain('# Model Adaptation: ' + MINIMAL_MODEL);
    expect(reminder).toContain('## Working rules delegated by the minimal prompt');
    expect(reminder).toContain('Curated guidance for this model family');
    for (const id of DELEGATED) {
      expect(reminder).toContain(behaviorContractClause(id).full);
      expect(rendered.system).not.toContain(behaviorContractClause(id).full);
    }
  });

  test('records the two system contracts and the four reminder contracts', async () => {
    const rendered = await renderProfile({ profile: 'deepseek-adapted', model: MINIMAL_MODEL, fixture });
    const byChannel = (channel: string) =>
      rendered.contractDelivery.filter((entry) => entry.channel === channel).map((entry) => entry.id);
    expect(byChannel('system')).toEqual(['authority_and_untrusted_content', 'act_and_verify']);
    expect(byChannel('reminder')).toEqual([...DELEGATED]);
    expect(byChannel('intentionally_omitted')).toEqual([]);

    const coverage = contractCoverageFor(rendered.contractDelivery, { reminderPresent: true });
    expect(contractCoverageGaps(coverage)).toEqual([]);
    for (const id of DELEGATED) expect(coverage[id]!.reminder).toBe(1);
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

  test('the reminder is smaller than the full prompt it replaces', async () => {
    const full = await renderProfile({ profile: 'full', model: FULL_MODEL, fixture });
    const minimal = await renderProfile({ profile: 'deepseek-adapted', model: MINIMAL_MODEL, fixture });
    expect(minimal.tokens.system).toBeLessThan(full.tokens.system);
    expect(minimal.tokens.reminder).toBeGreaterThan(0);
  });
});

describe('profile and model must match', () => {
  test('full with a minimal-shape model names both the profile and the model', async () => {
    expect(
      await codeOf(() => renderProfile({ profile: 'full', model: MINIMAL_MODEL, fixture })),
    ).toBe('profile_model_mismatch');
    const error = await renderProfile({
      profile: 'full',
      model: MINIMAL_MODEL,
      fixture,
    }).catch((e: unknown) => e as RenderedPromptError);
    expect(error.message).toContain('full');
    expect(error.message).toContain(MINIMAL_MODEL);
    expect(error.message).toContain('deepseek-adapted');
  });

  test('a minimal profile with a full-shape model is refused, not silently widened', async () => {
    expect(
      await codeOf(() => renderProfile({ profile: 'minimal', model: FULL_MODEL, fixture })),
    ).toBe('profile_model_mismatch');
  });

  test('deepseek-adapted with a model that has no curated adaptation is refused', async () => {
    expect(
      await codeOf(() => renderProfile({ profile: 'deepseek-adapted', model: 'some/other-model', fixture })),
    ).toBe('profile_model_mismatch');
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
  test('renders both profiles with no warning and no placeholder', async () => {
    const profiles = [
      ['full', FULL_MODEL],
      ['deepseek-adapted', MINIMAL_MODEL],
    ] as const;
    for (const [profile, model] of profiles) {
      const rendered = await renderProfile({
        profile,
        model,
        fixture: benchmarkFixture('/tmp/repo', 'linux'),
      });
      expect(rendered.warnings).toEqual([]);
      expect(rendered.system).not.toContain('${');
      expect(rendered.fixtureSummary.agentsMd).toBe('fixture');
    }
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
