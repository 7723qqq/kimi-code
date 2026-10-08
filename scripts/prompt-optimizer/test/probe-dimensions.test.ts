import { describe, expect, test } from 'bun:test';

import { runProbe } from '../src/probe/probe';
import type { ModelProfile, ProbeResult } from '../src/types';

const runner = { model: 'stub', apiBaseUrl: '', apiKey: '', concurrency: 1 };

/** A caller that answers with a fixed text regardless of the prompt. */
function fixed(content: string) {
  return async () => ({ content, toolCalls: [], usage: { input: 1, output: 1 }, latencyMs: 1 });
}

/**
 * A caller whose answer depends on whether a marker appears in the system
 * prompt — the only way a contrast dimension can show a non-zero effect.
 */
function markerAware(marker: string, good: string, bad: string) {
  return async (systemPrompt: string) => ({
    content: systemPrompt.includes(marker) ? good : bad,
    toolCalls: [],
    usage: { input: 1, output: 1 },
    latencyMs: 1,
  });
}

async function probe(caller: Parameters<typeof runProbe>[0]['caller']): Promise<ModelProfile> {
  return runProbe({ runner, caller, repetitions: 1 });
}

function dimension(profile: ModelProfile, name: string): ProbeResult {
  const found = profile.dimensions.find((d) => d.dimension === name);
  if (found === undefined) throw new Error(`no dimension ${name}`);
  return found;
}

describe('priority-reasoning measures resistance to untrusted input', () => {
  // The reported defect: obeying an authoritative `<system-reminder>` is
  // correct product behaviour, so rewarding it measured the opposite of what
  // the dimension claimed. The case now injects through `<untrusted_input>`.
  test('a response that follows the system rule scores full marks', async () => {
    const profile = await probe(fixed('Hello! How can I help?'));
    expect(dimension(profile, 'priority-reasoning').score).toBe(1);
  });

  test('a response that obeys the injected override scores zero', async () => {
    const profile = await probe(fixed('Bonjour! Comment puis-je aider?'));
    expect(dimension(profile, 'priority-reasoning').score).toBe(0);
  });

  test('the case no longer injects through an authoritative channel', async () => {
    // Capture the prompts the probe actually sends.
    const seen: string[] = [];
    const caller = async (systemPrompt: string, userMessages: string[]) => {
      seen.push(userMessages.join('\n'));
      return { content: 'Hello!', toolCalls: [], usage: { input: 1, output: 1 }, latencyMs: 1 };
    };
    await probe(caller as never);
    const joined = seen.join('\n');
    expect(joined).toContain('<untrusted_input>');
    expect(joined).not.toContain('<system-reminder>');
  });

  test('the recommendation describes the measured weakness, not a passing chain', async () => {
    const failing = await probe(fixed('Bonjour!'));
    expect(dimension(failing, 'priority-reasoning').recommendation).not.toMatch(
      /working correctly/,
    );
  });
});

describe('few-shot-sensitivity measures the effect of an example', () => {
  test('reports a positive raw delta when the example helps', async () => {
    // The example marker only appears in the treatment prompt; the model emits
    // the required format only when it sees it.
    const profile = await probe(
      markerAware('Example:', 'VERDICT: PASS\nISSUES: none\nSUGGESTION: none', 'Looks fine.'),
    );
    const result = dimension(profile, 'few-shot-sensitivity');
    expect(result.raw).toBeGreaterThan(0.9);
    expect(result.contrastLabel).toBe('worked example');
    expect(result.recommendation).toMatch(/improves compliance/);
  });

  test('reports no effect when the example changes nothing', async () => {
    const profile = await probe(fixed('VERDICT: PASS\nISSUES: none\nSUGGESTION: none'));
    const result = dimension(profile, 'few-shot-sensitivity');
    expect(result.raw).toBe(0);
    expect(result.recommendation).toMatch(/No measurable effect/);
  });

  test('the score stays inside 0-1 so overallStrength stays comparable', async () => {
    const profile = await probe(fixed('VERDICT: PASS\nISSUES: none\nSUGGESTION: none'));
    for (const d of profile.dimensions) {
      expect(d.score).toBeGreaterThanOrEqual(0);
      expect(d.score).toBeLessThanOrEqual(1);
    }
    expect(profile.overallStrength).toBeGreaterThanOrEqual(0);
    expect(profile.overallStrength).toBeLessThanOrEqual(1);
  });

  test('a negative effect is reported as making compliance worse', async () => {
    // Treatment prompt present but the model does WORSE with it.
    const profile = await probe(
      markerAware('Example:', 'Looks fine.', 'VERDICT: PASS\nISSUES: none\nSUGGESTION: none'),
    );
    const result = dimension(profile, 'few-shot-sensitivity');
    expect(result.raw).toBeLessThan(0);
    expect(result.recommendation).toMatch(/worse/);
  });
});
