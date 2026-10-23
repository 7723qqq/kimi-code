/**
 * Offline render check for the built-in prompt profiles.
 *
 * Uses the same production renderer the benchmark uses, so this shows what a
 * session actually receives: the system text, the DeepSeek adaptation reminder,
 * the contract channels, the token estimate and any renderer warning. No DI
 * runtime, no network, no user home file.
 */

import {
  benchmarkFixture,
  contractCoverageFor,
  contractCoverageGaps,
  isPromptProfile,
  PROMPT_PROFILES,
  renderProfile,
} from './rendered-prompt';

const argv = process.argv.slice(2);

function flag(name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`--${name} requires a value`);
  }
  return value;
}

const profile = flag('profile') ?? 'full';
if (!isPromptProfile(profile)) {
  throw new Error(`--profile must be one of: ${PROMPT_PROFILES.join(', ')}`);
}
const model = flag('model') ?? (profile === 'deepseek-adapted' ? 'deepseek-v4-pro' : 'kimi-k3-1');
const printPayload = argv.includes('--print');
const asJson = argv.includes('--json');

const rendered = await renderProfile({
  profile,
  model,
  fixture: benchmarkFixture(process.cwd()),
});

const unresolved = [...rendered.system.matchAll(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g)].map(
  (match) => match[1],
);
const coverage = contractCoverageFor(rendered.contractDelivery, {
  reminderPresent: rendered.reminder !== undefined,
});
const gaps = contractCoverageGaps(coverage);
const summary = {
  profile: rendered.profile,
  model: rendered.model,
  sourceHash: rendered.sourceHash,
  tokens: rendered.tokens,
  reminderSourceId: rendered.reminderSourceId ?? null,
  contractCoverage: coverage,
  contractGaps: gaps,
  warnings: rendered.warnings,
  unresolved,
  fixtureSummary: rendered.fixtureSummary,
};

if (asJson) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`profile=${rendered.profile} model=${rendered.model}`);
  console.log(`sourceHash=${rendered.sourceHash}`);
  console.log(`tokens: system=${rendered.tokens.system} reminder=${rendered.tokens.reminder}`);
  if (rendered.reminderSourceId !== undefined) {
    console.log(`reminder: ${rendered.reminderSourceId}`);
  }
  for (const id of Object.keys(coverage)) {
    const entry = coverage[id];
    if (entry === undefined) continue;
    console.log(
      `contract ${id}: system=${entry.system} reminder=${entry.reminder} omitted=${entry.omitted}`,
    );
  }
  console.log(
    `warnings=${rendered.warnings.length} unresolved=${unresolved.length} contractGaps=${gaps.length}`,
  );
}

if (printPayload) {
  console.log('\n===== SYSTEM =====\n');
  console.log(rendered.system);
  if (rendered.reminder !== undefined) {
    console.log('\n===== REMINDER =====\n');
    console.log(rendered.reminder);
  }
}

const failed = gaps.length > 0 || unresolved.length > 0 || rendered.warnings.length > 0;
process.exit(failed ? 1 : 0);
