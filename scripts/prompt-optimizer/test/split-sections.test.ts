import { describe, expect, test } from 'bun:test';

import { basename } from 'node:path';

import { loadConfig } from '../src/config';
import { loadPromptBundle, parsePromptSections } from '../src/prompt-parser';
import {
  benchmarkFixture,
  contractCoverageFor,
  contractCoverageGaps,
  renderProfile,
} from '../src/rendered-prompt';

const config = loadConfig();
const PROMPT_DIR = 'packages/agent-core-v2/src/app/agentProfileCatalog';

function sectionHeadings(readOnly = false): string[] {
  return loadPromptBundle(config.systemPromptPath, { readOnly }).sections.map((s) => s.heading);
}

describe('the prunable prompt covers the split sections', () => {
  // Regression guard: prune used to read `system.md` alone. After the prompt was
  // split, everything that was actually shortened lived in `coding.md`,
  // `delivering-work.md` and `project-information.md`, so the scan found nothing
  // to report while the real prompt carried hundreds of tokens.
  test('splices coding.md, delivering-work.md and project-information.md into the scan', () => {
    const bundle = loadPromptBundle(config.systemPromptPath);
    expect(bundle.files.map((path) => basename(path))).toEqual([
      'system.md',
      'coding.md',
      'delivering-work.md',
      'project-information.md',
    ]);
    expect(bundle.sections.map((section) => section.heading)).toContain('Coding');
  });

  test('attributes each split section to the file it is written in', () => {
    const bundle = loadPromptBundle(config.systemPromptPath);
    const byHeading = new Map(bundle.sections.map((s) => [s.heading, basename(s.sourceFile ?? '')]));
    expect(byHeading.get('Coding')).toBe('coding.md');
    expect(byHeading.get('Delivering work')).toBe('delivering-work.md');
    expect(byHeading.get('Project information')).toBe('project-information.md');
    expect(byHeading.get('Environment')).toBe('system.md');
  });

  test('the Coding section carries the text prune is meant to measure', () => {
    const bundle = loadPromptBundle(config.systemPromptPath);
    const coding = bundle.sections.find((section) => section.heading === 'Coding');
    expect(coding).toBeDefined();
    expect(coding!.content).toContain('Write code that fits the code around it');
    expect(coding!.tokens).toBeGreaterThan(0);
  });

  test('the read-only variant swaps Delivering work and drops Coding', () => {
    const bundle = loadPromptBundle(config.systemPromptPath, { readOnly: true });
    expect(bundle.readOnly).toBe(true);
    expect(bundle.files.map((path) => basename(path))).toEqual([
      'system.md',
      'delivering-work-read-only.md',
      'project-information.md',
    ]);

    const headings = bundle.sections.map((section) => section.heading);
    // A read-only profile is not given coding guidance, so it must not be scanned
    // as if it were.
    expect(headings).not.toContain('Coding');

    const delivering = bundle.sections.find((section) => section.heading === 'Delivering work');
    expect(delivering?.content).toContain('Find causes before naming them');
    expect(delivering?.content).not.toContain('Before you call a change done');
  });

  test('the full and read-only variants are never merged', () => {
    const full = loadPromptBundle(config.systemPromptPath);
    const readOnly = loadPromptBundle(config.systemPromptPath, { readOnly: true });
    expect(JSON.stringify(readOnly.files)).not.toContain('delivering-work.md');
    expect(readOnly.raw).not.toContain('Before you call a change done');
    expect(full.raw).not.toContain('Find causes before naming them');
  });

  test('a missing section file fails loudly instead of scanning less', () => {
    expect(() =>
      loadPromptBundle(`${PROMPT_DIR}/system.md`.replace(PROMPT_DIR, 'scripts/does-not-exist')),
    ).toThrow();
  });
});

describe('the rendered prompt still carries every section', () => {
  // `renderProfile` is the production path; the bundle above is a scan aid. If
  // the two disagreed, prune would report on text no session receives.
  test('renders the four split sections with their text', async () => {
    const rendered = await renderProfile({
      profile: 'full',
      model: 'kimi-k3-1',
      fixture: benchmarkFixture(process.cwd()),
    });

    expect(rendered.system).toContain('Write code that fits the code around it');
    expect(rendered.system).toContain('Do what was asked');
    expect(rendered.system).toContain('The applicable `AGENTS.md` instructions are:');
    expect(rendered.system).toContain('If you change anything an `AGENTS.md` documents');
    expect(rendered.system).not.toContain('${');
  });

  test('the rendered prompt and the scanned bundle agree on the section headings', async () => {
    const rendered = await renderProfile({
      profile: 'full',
      model: 'kimi-k3-1',
      fixture: benchmarkFixture(process.cwd()),
    });
    const renderedHeadings = new Set(parsePromptSections(rendered.system).map((s) => s.heading));
    const scanned = sectionHeadings();
    for (const heading of ['Coding', 'Delivering work', 'Project information', 'Environment']) {
      expect(scanned).toContain(heading);
      expect(renderedHeadings.has(heading)).toBe(true);
    }
  });

  test('the scan bundle carries the split sections, not just the skeleton', () => {
    const bundle = loadPromptBundle(config.systemPromptPath);
    const skeletonOnly = parsePromptSections(bundle.raw.slice(0, bundle.raw.indexOf('# Coding')));
    expect(bundle.raw).toContain('Write code that fits the code around it');
    expect(bundle.sections.length).toBeGreaterThan(skeletonOnly.length);
  });
});

describe('the benchmark can render either prompt shape', () => {
  // A read-only profile (explore, plan) is not given coding guidance and gets a
  // three-sentence Delivering work section. Benchmarking only the full shape and
  // applying its verdict to those agents would measure text they never receive.
  test('the read-only shape drops Coding and shortens Delivering work', async () => {
    const full = await renderProfile({
      profile: 'full',
      model: 'kimi-k3-1',
      fixture: benchmarkFixture(process.cwd()),
    });
    const readOnly = await renderProfile({
      profile: 'full',
      model: 'kimi-k3-1',
      fixture: benchmarkFixture(process.cwd()),
      readOnly: true,
    });

    expect(full.system).toContain('Write code that fits the code around it');
    expect(readOnly.system).not.toContain('Write code that fits the code around it');
    expect(readOnly.system).toContain('Find causes before naming them');
    expect(readOnly.system).not.toContain('Before you call a change done');
    expect(readOnly.tokens.system).toBeLessThan(full.tokens.system);
  });

  test('the two shapes never share a source hash', async () => {
    const fixture = benchmarkFixture(process.cwd());
    const full = await renderProfile({ profile: 'full', model: 'kimi-k3-1', fixture });
    const readOnly = await renderProfile({
      profile: 'full',
      model: 'kimi-k3-1',
      fixture,
      readOnly: true,
    });
    expect(readOnly.sourceHash).not.toBe(full.sourceHash);
  });

  test('the shape is reported on the render and in the fixture summary', async () => {
    const fixture = benchmarkFixture(process.cwd());
    expect((await renderProfile({ profile: 'full', model: 'kimi-k3-1', fixture })).readOnly).toBe(
      false,
    );
    const readOnly = await renderProfile({
      profile: 'full',
      model: 'kimi-k3-1',
      fixture,
      readOnly: true,
    });
    expect(readOnly.readOnly).toBe(true);
    expect(readOnly.fixtureSummary.readOnly).toBe(true);
  });

  test('both shapes keep all six core contracts in the system text', async () => {
    for (const readOnly of [false, true]) {
      const rendered = await renderProfile({
        profile: 'full',
        model: 'kimi-k3-1',
        fixture: benchmarkFixture(process.cwd()),
        readOnly,
      });
      expect(contractCoverageGaps(contractCoverageFor(rendered.contractDelivery))).toEqual([]);
      expect(rendered.system).not.toContain('${');
    }
  });
});
