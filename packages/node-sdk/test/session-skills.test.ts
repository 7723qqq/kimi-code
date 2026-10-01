/**
 * Scenario: public SDK skill discovery and activation.
 * Responsibilities: list workspace/session skills and activate a session skill through KimiHarness.
 * Wiring: the in-process core and filesystem are real; only the remote model provider is stubbed.
 * Run: bunx vitest run packages/node-sdk/test/session-skills.test.ts
 */
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { resolve, win32, join } from 'node:path';

import type * as KosongModule from '@moonshot-ai/kosong';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import { createKimiHarness, type Event, type KimiError, type SkillSummary } from '#/index';
import type { SDKRpcClientBase } from '#/rpc';

import {
  makeTempDir,
  removeTempDirs,
  waitForAgentWireEvent,
  waitForSDKEvent,
} from './session-runtime-helpers';
import { TEST_IDENTITY } from './test-identity';

/** Windows-shaped paths resolve as win32 and fold to forward slashes. */
function normalizeWorkDir(workDir: string): string {
  if (/^[A-Za-z]:[\\/]/.test(workDir) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(workDir)) {
    return win32.resolve(workDir).replaceAll('\\', '/');
  }
  return resolve(workDir);
}

const fakeProviderState = vi.hoisted(() => ({
  histories: [] as unknown[],
  responseText: 'skill response',
}));

vi.mock('@moonshot-ai/kosong', async (importOriginal) => {
  const actual = await importOriginal<typeof KosongModule>();
  return {
    ...actual,
    createProvider: () => ({
      name: 'fake',
      modelName: 'fake-model',
      thinkingEffort: null,
      async generate(_systemPrompt: string, _tools: unknown, history: unknown) {
        fakeProviderState.histories.push(history);
        return {
          id: 'fake-response',
          usage: {
            inputOther: 0,
            output: 1,
            inputCacheRead: 0,
            inputCacheCreation: 0,
          },
          finishReason: 'completed',
          rawFinishReason: 'stop',
          async *[Symbol.asyncIterator]() {
            yield { type: 'text', text: fakeProviderState.responseText };
          },
        };
      },
      withThinking() {
        return this;
      },
    }),
  };
});

const { Session } = await import('#/index');

const tempDirs: string[] = [];

beforeEach(() => {
  fakeProviderState.histories.length = 0;
  fakeProviderState.responseText = 'skill response';
});

afterEach(async () => {
  await removeTempDirs(tempDirs);
  vi.unstubAllEnvs();
});

describe('Session skills', () => {
  it('lists session skills without exposing content', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      'disable_model_invocation: true',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_list', workDir });

      const skills = await session.listSkills();
      const listed = skills.find((skill) => skill.name === 'review');

      expect(listed).toMatchObject({
        name: 'review',
        description: 'Review code',
        source: 'project',
        disableModelInvocation: true,
      });
      expect(listed?.path?.endsWith('/.kimi-code/skills/review/SKILL.md')).toBe(true);
      expect(JSON.stringify(skills)).not.toContain('Review the requested file.');
    } finally {
      await harness.close();
    }
  });

  // v2 serves the skill catalog from the engine, so the slash panel can offer
  // the builtin product skills and the dotted sub-skill commands. The host used
  // to scan the filesystem itself and therefore listed no builtins at all, even
  // though the system prompt advertised them.
  it('lists the engine catalog: builtins and dotted sub-skills', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-builtin-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-builtin-work-');
    // A nested skill under a `has-sub-skill: true` parent: only the engine scan
    // registers it, and it is offered as `<parent>.<child>`.
    const bundle = join(workDir, '.agents', 'skills', 'bundle');
    await mkdir(join(bundle, 'child'), { recursive: true });
    await writeFile(
      join(bundle, 'SKILL.md'),
      ['---', 'name: bundle', 'description: Container', 'has-sub-skill: true', '---', '', 'Body.'].join(
        '\n',
      ),
    );
    await writeFile(
      join(bundle, 'child', 'SKILL.md'),
      ['---', 'name: child', 'description: A child', '---', '', 'Child body.'].join('\n'),
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_builtin_list', workDir });

      const skills = await session.listSkills();
      const byName = new Map(skills.map((skill) => [skill.name, skill]));

      // Builtin product skills — a host-side scan never produced these.
      expect(byName.get('update-config')?.source).toBe('builtin');
      expect(byName.get('import-from-cc-codex')?.disableModelInvocation).toBe(true);

      // The sub-skill bundle: the parent is an ordinary skill, the children
      // carry the flag the TUI uses to expose `/sub-skill.review` unprefixed.
      expect(byName.get('sub-skill')?.isSubSkill).toBeUndefined();
      for (const child of ['sub-skill.review', 'sub-skill.consolidate']) {
        expect(byName.get(child)?.isSubSkill).toBe(true);
        expect(byName.get(child)?.disableModelInvocation).toBe(true);
      }

      // A file-discovered parent, and the child its parent qualified.
      expect(byName.get('bundle')?.isSubSkill).toBeUndefined();
      expect(byName.get('bundle.child')?.isSubSkill).toBe(true);
      // The catalog still carries metadata only, never a body.
      expect(JSON.stringify(skills)).not.toContain('Child body.');
    } finally {
      await harness.close();
    }
  });

  it('activates a skill through core and emits the public skill event', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_activate', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });
      const activated = waitForSDKEvent(session, (event) => event.type === 'skill.activated');
      const metaUpdated = waitForSDKEvent(
        session,
        (event) => event.type === 'session.meta.updated',
      );
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');
      const started = waitForSDKEvent(session, (event) => event.type === 'turn.started');

      await session.activateSkill(' review ', ' src/app.ts ');
      const activatedEvent = await activated;
      const metaEvent = await metaUpdated;
      const startedEvent = await started;
      await ended;
      unsubscribe();

      expect(activatedEvent).toMatchObject({
        type: 'skill.activated',
        sessionId: session.id,
        agentId: 'main',
        skillName: 'review',
        skillArgs: 'src/app.ts',
        trigger: 'user-slash',
        skillSource: 'project',
      });
      // v2 #3832: the activation rides the turn as a `skill_activation`
      // prompt origin — the same activationId the event carries — so an
      // origin-aware consumer can tell this turn from a typed prompt.
      const activationId = (activatedEvent as { activationId?: string }).activationId;
      expect(typeof activationId).toBe('string');
      expect(startedEvent).toMatchObject({
        type: 'turn.started',
        origin: {
          kind: 'skill_activation',
          activationId,
          skillName: 'review',
          skillArgs: 'src/app.ts',
          trigger: 'user-slash',
          skillSource: 'project',
        },
      });
      expect(JSON.stringify(activatedEvent)).not.toContain('Review the requested file.');
      expect(events.findIndex((event) => event.type === 'skill.activated')).toBeGreaterThanOrEqual(
        0,
      );
      expect(events.findIndex((event) => event.type === 'turn.started')).toBeGreaterThan(
        events.findIndex((event) => event.type === 'skill.activated'),
      );
      expect(metaEvent).toMatchObject({
        type: 'session.meta.updated',
        sessionId: session.id,
        agentId: 'main',
        title: '/review src/app.ts',
        // v2's prompt-metadata event patch carries the title; the
        // isCustomTitle/lastPrompt fields are only in the state document.
        patch: {
          title: '/review src/app.ts',
        },
      });

      const statePath = join(session.summary!.sessionDir, 'session-meta.json');
      const state = JSON.parse(await readFile(statePath, 'utf-8')) as Record<string, unknown>;
      expect(state['title']).toBe('/review src/app.ts');
      expect(state['isCustomTitle']).toBe(false);
      expect(state['lastPrompt']).toBe('/review src/app.ts');
    } finally {
      await harness.close();
    }
  });

  it('rejects the whole bundle when one of the named skills is unknown', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-bundle-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-bundle-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_bundle', workDir });

      // The bundle is validated as a unit: an unknown name rejects the whole
      // submission, the same way `activateSkill` reports a missing skill.
      // Silently dropping it would return a successful turn that activated
      // less than the caller asked for, and the model would see a prompt
      // missing the skill the user named.
      await expect(
        session.promptWithSkills('Review this change.', [{ name: 'review' }, { name: 'not-installed' }]),
      ).rejects.toMatchObject({ code: 'skill.not_found' });
    } finally {
      await harness.close();
    }
  });

  it('publishes one skill.activated per bundled skill, ahead of the turn', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-bundle-events-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-bundle-events-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    await writeSkill(workDir, 'security', [
      '---',
      'name: security',
      'description: Check security',
      '---',
      '',
      'Check the requested file for security issues.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_bundle_events', workDir });
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      await session.promptWithSkills(
        'Review this change.',
        [{ name: 'review' }, { name: 'security' }],
      );
      unsubscribe();

      // The TUI renders an activation card per event and groups the cards
      // with the prompt they were bundled into, which only works if the
      // events land during this call. The single-slash path (`activateSkill`)
      // already does this; the bundle path used to emit nothing at all.
      const activated = events.filter(
        (event): event is Extract<Event, { type: 'skill.activated' }> =>
          event.type === 'skill.activated',
      );
      expect(activated.map((event) => event.skillName)).toEqual(['review', 'security']);
      expect(new Set(activated.map((event) => event.activationId)).size).toBe(2);
    } finally {
      await harness.close();
    }
  });

  it('derives the title and lastPrompt from the caller text, not the skill body', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-bundle-meta-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-bundle-meta-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_bundle_meta', workDir });
      const metaUpdated = waitForSDKEvent(
        session,
        (event) => event.type === 'session.meta.updated',
      );
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

      await session.promptWithSkills('Please fix the failing test', [{ name: 'review' }]);
      const meta = (await metaUpdated) as { title?: string };
      await ended;

      // v2 `AgentSkillService.promptWithSkills` derives the metadata from the
      // caller's own parts (`skillService.ts:139-146`), not from the message
      // content, which is the rendered skill blocks plus those parts (`:155`).
      // Deriving it from the content instead made a session's title open with
      // `User activated the skill ...` and the `<skill-loaded>` wrapper instead
      // of the user's sentence.
      expect(meta.title).toBe('Please fix the failing test');
      const state = JSON.parse(
        await readFile(join(session.summary!.sessionDir, 'session-meta.json'), 'utf-8'),
      ) as Record<string, unknown>;
      expect(state['title']).toBe('Please fix the failing test');
      expect(state['lastPrompt']).toBe('Please fix the failing test');
    } finally {
      await harness.close();
    }
  });

  it('attributes a btw activation to the agent that ran it (v2 skillService.ts:248)', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-btw-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-btw-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_btw', workDir });
      const agentId = await session.startBtw();
      const events: Event[] = [];
      const unsubscribe = session.onEvent((event) => {
        events.push(event);
      });

      // The same seam the btw panel submits through
      // (`btw-panel.ts:186`): the submission runs inside the subagent's scope.
      await harness.withInteractiveAgent(agentId, () =>
        session.promptWithSkills('Review this change.', [{ name: 'review' }]),
      );
      unsubscribe();

      const activated = events.filter(
        (event): event is Extract<Event, { type: 'skill.activated' }> =>
          event.type === 'skill.activated',
      );
      expect(activated).toHaveLength(1);
      // v2 stamps `SkillActivated` with the scope's agent id. Hardcoding `main`
      // filed a btw panel's activation under the main agent, which the panel's
      // own transcript never shows.
      expect(activated[0]?.agentId).toBe(agentId);
    } finally {
      await harness.close();
    }
  });

  it('rejects an empty prompt or an empty skill list before touching the catalog', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-empty-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-empty-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_empty', workDir });

      // v2 `skillService.ts:129-134`. Without the pre-check an empty skill list
      // degraded into an ordinary prompt — a successful turn that activated
      // nothing, which is exactly the failure mode the check exists to stop.
      await expect(session.promptWithSkills('Do the thing.', [])).rejects.toMatchObject({
        code: 'request.invalid',
      });
      // The sibling check on empty *input* (`skillService.ts:126-128`) lives at
      // the RPC boundary and is unreachable through this API: the shared
      // `normalizePromptInput` rejects an empty prompt first, with the code
      // `prompt()` also uses. Pinned here so that stays true rather than
      // drifting into a second error code for one input.
      await expect(session.promptWithSkills('', [{ name: 'review' }])).rejects.toMatchObject({
        code: 'request.prompt_input_empty',
      });
    } finally {
      await harness.close();
    }
  });

  it('carries the origin metadata as v2 entry list, plus attachments and trailing content', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-origin-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-origin-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_origin', workDir });
      const started = waitForSDKEvent(session, (event) => event.type === 'turn.started');

      await session.activateSkill('review', 'src/app.ts', {
        displayText: '/review src/app.ts',
        content: 'Also check the tests.',
        attachments: [
          { name: 'notes.md', mediaType: 'text/markdown', size: 12, path: '/w/notes.md' },
        ],
      });
      const turnStarted = (await started) as { origin?: Record<string, unknown> };
      const origin = turnStarted.origin ?? {};

      // v2 carries origin metadata as an ARRAY of per-submission entries. The
      // fork sent one object, which `transcript`'s projection reads as "no
      // metadata" — the displayText was silently dropped on every prompt.
      expect(origin['clientMetadata']).toEqual([{ display_text: '/review src/app.ts' }]);
      // v2 `SkillActivationOrigin.attachments`, which the transcript cold
      // rebuild folds into attachment entities (`groupTurns.ts:524`).
      expect(origin['attachments']).toEqual([
        { name: 'notes.md', mediaType: 'text/markdown', size: 12, path: '/w/notes.md' },
      ]);

      // The bundle path carries the same two fields on its *user* origin
      // (`skillService.ts:158-163`); it previously carried neither, so a
      // bundled prompt's displayText and attachments were both lost.
      const bundled = waitForSDKEvent(session, (event) => event.type === 'turn.started');
      await session.promptWithSkills('Review this change.', [{ name: 'review' }], {
        displayText: 'Review this change.',
        attachments: [
          { name: 'diff.patch', mediaType: 'text/x-patch', size: 40, path: '/w/diff.patch' },
        ],
      });
      const bundleOrigin =
        ((await bundled) as { origin?: Record<string, unknown> }).origin ?? {};
      expect(bundleOrigin['clientMetadata']).toEqual([{ display_text: 'Review this change.' }]);
      expect(bundleOrigin['attachments']).toEqual([
        { name: 'diff.patch', mediaType: 'text/x-patch', size: 40, path: '/w/diff.patch' },
      ]);
      expect(Array.isArray(bundleOrigin['skillActivations'])).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('records a user-slash activation in telemetry (v2 skillService.ts:277-287)', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-telemetry-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-telemetry-work-');
    await writeSkill(workDir, 'review', [
      '---',
      'name: review',
      'description: Review code',
      '---',
      '',
      'Review the requested file.',
    ]);
    const tracked: { event: string; properties?: Record<string, unknown> }[] = [];
    const harness = createKimiHarness({
      homeDir,
      identity: TEST_IDENTITY,
      telemetry: {
        track: (event: string, properties?: Record<string, unknown>) => {
          tracked.push({ event, properties });
        },
      },
    });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_telemetry', workDir });
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

      await session.activateSkill('review');
      await ended;

      // Only the model-tool path emitted this, so skill usage stats counted
      // model-invoked skills only.
      expect(tracked).toContainEqual({
        event: 'skill_invoked',
        properties: { skill_name: 'review', trigger: 'user-slash' },
      });
      // Not a `flow` skill, so no second event.
      expect(tracked.filter((entry) => entry.event === 'flow_invoked')).toEqual([]);
    } finally {
      await harness.close();
    }
  });

  it('activates a builtin skill the host-side renderer could not resolve', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-builtin-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-builtin-work-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_builtin', workDir });
      const activated = waitForSDKEvent(session, (event) => event.type === 'skill.activated');
      const ended = waitForSDKEvent(session, (event) => event.type === 'turn.ended');

      // `update-config` is compiled into the engine (`skills/mod.rs:434`), so it
      // has no `SKILL.md` under `<workDir>/.kimi-code/skills`. The host used to
      // resolve a `/skill:` name by that path alone and answered
      // `skill.not_found` for every builtin and every `extra_skill_dirs` entry.
      await session.activateSkill('update-config');
      const event = await activated;
      await ended;

      expect(event).toMatchObject({
        type: 'skill.activated',
        skillName: 'update-config',
        trigger: 'user-slash',
        // Provenance comes from the catalog now, not from a path guess — the
        // host used to stamp `source="project"` on whatever it found.
        skillSource: 'builtin',
      });
      expect(JSON.stringify(event)).not.toContain('.kimi-code/skills');
    } finally {
      await harness.close();
    }
  });

  it('refuses a skill whose type is not user-activatable (v2 skillService.ts:199)', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-type-gate-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-type-gate-work-');
    await mkdir(join(workDir, '.kimi-code', 'skills', 'docs-ref'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'skills', 'docs-ref', 'SKILL.md'),
      [
        '---',
        'name: docs-ref',
        'description: Reference only',
        'type: reference',
        '---',
        '',
        'Body.',
      ].join('\n'),
    );
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_type_gate', workDir });

      // v2 raises `SKILL_TYPE_UNSUPPORTED` for a `reference` skill; the host
      // used to accept it, because it never read the type at all.
      await expect(session.activateSkill('docs-ref')).rejects.toMatchObject({
        code: 'skill.type_unsupported',
      });
      // The same gate covers a bundled submission, and rejects the whole bundle.
      await expect(
        session.promptWithSkills('Read it.', [{ name: 'docs-ref' }]),
      ).rejects.toMatchObject({ code: 'skill.type_unsupported' });
    } finally {
      await harness.close();
    }
  });

  it('resolves user brand skills from KIMI_CODE_HOME, not the OS home', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-home-');
    const processHome = await makeTempDir(tempDirs, 'kimi-sdk-skills-process-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-skills-work-');
    vi.stubEnv('HOME', processHome);
    vi.stubEnv('KIMI_CODE_HOME', homeDir);
    await writeLegacyUserSkill(processHome, 'sdk-real-home-only', 'SDK real home skill');
    await writeBrandUserSkill(homeDir, 'sdk-sandbox-only', 'SDK sandbox skill');
    const harness = createKimiHarness({ identity: TEST_IDENTITY });

    try {
      const session = await harness.createSession({ id: 'ses_sdk_skill_env_home', workDir });
      const names = new Set((await session.listSkills()).map((skill) => skill.name));

      expect(names.has('sdk-real-home-only')).toBe(false);
      expect(names.has('sdk-sandbox-only')).toBe(true);
    } finally {
      await harness.close();
    }
  });

  it('rejects empty names before calling RPC and rejects after close', async () => {
    const activateSkill = vi.fn(async () => {});
    const closeSession = vi.fn(async (_input: { readonly sessionId: string }) => {});
    const clearSessionHandlers = vi.fn();
    const listSkills = vi.fn(async () => []);
    const session = new Session({
      id: 'ses_skill_validation',
      workDir: '/tmp/work',
      rpc: {
        activateSkill,
        closeSession,
        clearSessionHandlers,
        listSkills,
      } as unknown as SDKRpcClientBase,
    });

    await expect(session.activateSkill('   ')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'skill.name_empty',
    } satisfies Partial<KimiError>);
    expect(activateSkill).not.toHaveBeenCalled();

    await session.close();
    expect(closeSession).toHaveBeenCalledWith({ sessionId: session.id });
    expect(clearSessionHandlers).toHaveBeenCalledWith(session.id);
    await expect(session.listSkills()).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
    await expect(session.activateSkill('review')).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
  });

  it('finalizes local close state when the core close RPC fails', async () => {
    const closeSession = vi.fn(async (_input: { readonly sessionId: string }) => {
      throw new Error('flush failed');
    });
    const clearSessionHandlers = vi.fn();
    const listSkills = vi.fn(async () => []);
    const activateSkill = vi.fn(async () => {});
    const session = new Session({
      id: 'ses_close_failed',
      workDir: '/tmp/work',
      rpc: {
        activateSkill,
        closeSession,
        clearSessionHandlers,
        listSkills,
      } as unknown as SDKRpcClientBase,
    });

    await expect(session.close()).rejects.toThrow('flush failed');
    await expect(session.close()).resolves.toBeUndefined();
    expect(closeSession).toHaveBeenCalledTimes(1);
    expect(clearSessionHandlers).toHaveBeenCalledWith(session.id);
    await expect(session.listSkills()).rejects.toMatchObject({
      name: 'KimiError',
      code: 'session.closed',
    } satisfies Partial<KimiError>);
  });

  it('exposes public skill event and summary types', () => {
    expectTypeOf<SkillSummary['name']>().toEqualTypeOf<string>();
    // `skill.activated` is a member of the v2 `Event` union; narrow by type.
    expectTypeOf<Event>().not.toBeNever();
  });
});

describe('KimiHarness workspace skills', () => {
  it('returns project skills when no session exists', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-home-');
    const workDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-work-');
    await writeSkill(workDir, 'workspace-review', [
      '---',
      'name: workspace-review',
      'description: Review workspace changes',
      '---',
      '',
      'Inspect every changed file.',
    ]);
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      const skills = await harness.listWorkspaceSkills(workDir);

      expect(skills.find((skill) => skill.name === 'workspace-review')).toMatchObject({
        name: 'workspace-review',
        description: 'Review workspace changes',
        source: 'project',
      });
      expect(harness.sessions.size).toBe(0);
    } finally {
      await harness.close();
    }
  });

  it('preserves the core error when workDir is empty', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-home-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(harness.listWorkspaceSkills('   ')).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
        message: 'listWorkspaceSkills requires workDir',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });

  it('preserves the core error when workDir is not a string', async () => {
    const homeDir = await makeTempDir(tempDirs, 'kimi-sdk-workspace-skills-home-');
    const harness = createKimiHarness({ homeDir, identity: TEST_IDENTITY });

    try {
      await expect(harness.listWorkspaceSkills(null as never)).rejects.toMatchObject({
        name: 'KimiError',
        code: 'request.work_dir_required',
        message: 'listWorkspaceSkills requires workDir',
      } satisfies Partial<KimiError>);
    } finally {
      await harness.close();
    }
  });
});

async function writeSkill(workDir: string, name: string, lines: readonly string[]): Promise<void> {
  const dir = join(workDir, '.kimi-code', 'skills', name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'SKILL.md'), lines.join('\n'));
}

async function writeLegacyUserSkill(
  userHomeDir: string,
  name: string,
  description: string,
): Promise<void> {
  await writeSkillFile(join(userHomeDir, '.kimi-code', 'skills', name), name, description);
}

async function writeBrandUserSkill(
  brandHomeDir: string,
  name: string,
  description: string,
): Promise<void> {
  await writeSkillFile(join(brandHomeDir, 'skills', name), name, description);
}

async function writeSkillFile(dir: string, name: string, description: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'SKILL.md'),
    ['---', `name: ${name}`, `description: ${description}`, '---', '', `${description}.`].join(
      '\n',
    ),
  );
}
