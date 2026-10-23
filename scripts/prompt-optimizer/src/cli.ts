/**
 * Prompt Optimizer — CLI entry point.
 *
 * Usage:
 *   bun src/cli.ts bench [--profile <full|minimal|deepseek-adapted>] [--model <model>]
 *   bun src/cli.ts bench --compare <a,b>   Raw-template prune experiment
 *   bun src/cli.ts prune [--model <model>] [--dry-run]
 *   bun src/cli.ts ab    [--model <model>] [--experiment <file>] [--dry-run]
 *   bun src/cli.ts probe [--model <model>] [--reps <n>] [--dry-run]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatABReport, runABExperiment } from './ab-test/ab-test';
import { VariantSpecError, buildVariants } from './ab-test/variants';
import { BENCHMARK_CASES } from './benchmark/cases';
import {
  runSuite,
  aggregateResults,
  dryRunCaller,
  runRenderedSuite,
  type LLMCaller,
  type RunnerConfig,
} from './benchmark/runner';
import { parseArgs, CliArgError, type CliArgs } from './cli-args';
import { loadConfig } from './config';
import { realCaller, resolveCredentials, resolveModel } from './llm-caller';
import { runProbe, formatProbeReport } from './probe/probe';
import { loadPrompt, generateBaselineVariant, generatePruneVariant } from './prompt-parser';
import { runPruner, formatPruneReport } from './pruner/pruner';
import {
  ContractCoverageError,
  buildEvaluationReport,
  formatEvaluationReport,
  generateComparisonReport,
  type CompareInput,
} from './report/report';
import {
  benchmarkFixture,
  contractCoverageFor,
  contractCoverageGaps,
  renderProfile,
  RenderedPromptError,
  PROMPT_PROFILES,
  type PromptProfile,
} from './rendered-prompt';

/**
 * A model id is not a filename: `workbuddy/deepseek-v4.1-flash` contains a
 * separator, so writing a report named after it created a subdirectory that
 * does not exist. Flatten anything that is not safe in a filename.
 */
export function slugifyModel(model: string): string {
  const slug = model
    .trim()
    .replaceAll(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  return slug.length > 0 ? slug : 'model';
}

/**
 * Exit code for a report the completeness gate refused to produce.
 */
export const GATE_FAILURE_EXIT_CODE = 3;

interface CredentialState {
  readonly apiKey: string;
  readonly error?: string;
}

/**
 * Resolve credentials without turning a dry run into a crash.
 *
 * A real run must fail loudly when the model names a provider the config does
 * not declare; a dry run is exactly the mode you use to find that out, so there
 * the failure is recorded as the reason no key was found.
 */
function credentialStateFor(runnerConfig: RunnerConfig, dryRun: boolean): CredentialState {
  try {
    return { apiKey: resolveCredentials(runnerConfig).apiKey };
  } catch (error: unknown) {
    if (!dryRun) throw error;
    return { apiKey: '', error: error instanceof Error ? error.message : String(error) };
  }
}

function printContractBlockers(error: ContractCoverageError): void {
  console.error(`Error: ${error.message}`);
  console.error(`  Missing contracts: ${error.gaps.join(', ')}`);
  console.error('  No report was written: a report without these channels cannot be a verdict.');
}

/**
 * The default bench input: a production-rendered profile.
 */
async function benchRendered(options: {
  args: CliArgs;
  config: OptimizerConfig;
  runnerConfig: RunnerConfig;
  caller: LLMCaller;
  model: string;
  dryRun: boolean;
  credentials: CredentialState;
}): Promise<void> {
  const { args, config, runnerConfig, caller, model, dryRun, credentials } = options;
  const profile: PromptProfile = args.profile;
  const rendered = await renderProfile({
    profile,
    model,
    fixture: benchmarkFixture(process.cwd()),
    ...(args.actualGlobal === undefined ? {} : { actualGlobalPath: args.actualGlobal }),
  });

  console.log(
    `Rendered profile "${profile}" for model ${model}` +
      ` (system ${rendered.tokens.system} tokens, reminder ${rendered.tokens.reminder} tokens)`,
  );
  console.log(`Source hash: ${rendered.sourceHash}`);
  console.log(
    `Fixture: agentsMd=${rendered.fixtureSummary.agentsMd}` +
      ` (${rendered.fixtureSummary.agentsMdChars} chars),` +
      ` skills ${rendered.fixtureSummary.skillsChars} chars,` +
      ` plugins ${rendered.fixtureSummary.plugins ? 'yes' : 'no'}`,
  );
  if (rendered.reminderSourceId !== undefined) {
    console.log(`Reminder: ${rendered.reminderSourceId}`);
  }
  for (const warning of rendered.warnings) console.log(`Render warning: ${warning.message}`);

  // Refuse before spending calls. A profile that delivers a core contract through
  // no channel cannot produce a report, and discovering that after 41 API calls
  // buys an answer already known.
  const gaps = contractCoverageGaps(
    contractCoverageFor(rendered.contractDelivery, {
      reminderPresent: (rendered.reminder ?? '').length > 0,
    }),
  );
  if (gaps.length > 0) throw new ContractCoverageError(profile, gaps);

  // A dry run answers every case from the same template, so its numbers cannot
  // say anything about this profile. Say it before the numbers appear.
  const effectiveDryRun = dryRun || credentials.apiKey.length === 0;
  if (effectiveDryRun) {
    console.warn(
      'Note: dry-run — responses do not depend on the prompt, so nothing below is an\n' +
        '      effectiveness verdict. Run without --dry-run and with credentials for one.',
    );
  }

  console.log(`Running ${BENCHMARK_CASES.length} cases…`);
  const run = await runRenderedSuite(
    BENCHMARK_CASES,
    {
      name: profile,
      system: rendered.system,
      ...(rendered.reminder === undefined ? {} : { reminder: rendered.reminder }),
      profile: rendered.profile,
      sourceHash: rendered.sourceHash,
      fixtureSummary: { ...rendered.fixtureSummary },
      contractDelivery: rendered.contractDelivery,
      tokens: { system: rendered.tokens.system, reminder: rendered.tokens.reminder },
    },
    caller,
    runnerConfig,
  );

  const report = buildEvaluationReport({
    model,
    profile,
    sourceHash: rendered.sourceHash,
    fixtureSummary: { ...rendered.fixtureSummary },
    contractDelivery: rendered.contractDelivery,
    reminderPresent: (rendered.reminder ?? '').length > 0,
    tokens: rendered.tokens,
    cases: BENCHMARK_CASES,
    results: run.results,
    apiErrors: run.apiErrors,
    dryRun: effectiveDryRun,
    credentialsPresent: credentials.apiKey.length > 0,
    warnings: rendered.warnings,
  });

  console.log('');
  console.log(formatEvaluationReport(report));

  const reportPath = resolve(
    config.outputDir,
    `bench-${profile}-${slugifyModel(model)}-${Date.now()}.json`,
  );
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`\nFull report: ${reportPath}`);

  if (report.effectivenessVerdict === 'unavailable') {
    console.log(
      'Effectiveness: unavailable — this run is not evidence about the prompt. ' +
        'See effectivenessBlockers in the report.',
    );
  }
}

/**
 * The raw-template experiment.
 *
 * `system.md` is a template with `${...}` placeholders, so this measures pruning
 * of source text, not a prompt a session receives. Kept because it is the only
 * way to compare prune variants; labelled so its output cannot be mistaken for a
 * production evaluation.
 */
async function benchRawTemplate(options: {
  args: CliArgs;
  config: OptimizerConfig;
  runnerConfig: RunnerConfig;
  caller: LLMCaller;
  model: string;
  dryRun: boolean;
}): Promise<void> {
  const { args, config, runnerConfig, caller, model, dryRun } = options;
  const { sections } = loadPrompt(config.systemPromptPath);
  const label = 'raw-template experiment (system.md source text, not a rendered prompt)';
  const compareArg = args.compare;

  if (compareArg) {
    const variantNames = compareArg.split(',');
    console.log(
      `[${label}] Comparing variants: ${variantNames.join(' vs ')} (model: ${model}, dry-run: ${dryRun})`,
    );
    const compareInputs: CompareInput[] = [];

    for (const vName of variantNames) {
      const variant =
        vName.trim() === 'base'
          ? generateBaselineVariant(sections)
          : generatePruneVariant(sections, vName.trim());
      const results = await runSuite(BENCHMARK_CASES, variant, caller, runnerConfig);
      compareInputs.push({ name: vName.trim(), results });
    }

    console.log('\n' + generateComparisonReport(compareInputs));

    const reportPath = resolve(config.outputDir, `compare-${slugifyModel(model)}-${Date.now()}.json`);
    writeFileSync(
      reportPath,
      JSON.stringify(
        compareInputs.map((c) => ({ name: c.name, aggregate: aggregateResults(c.results) })),
        null,
        2,
      ),
    );
    console.log(`\nFull report: ${reportPath}`);
    return;
  }

  const variantName = args.variant ?? 'base';
  console.log(
    `[${label}] Running benchmark suite (${BENCHMARK_CASES.length} cases, model: ${model}, ` +
      `variant: ${variantName}, dry-run: ${dryRun})`,
  );
  const variant =
    variantName === 'base'
      ? generateBaselineVariant(sections)
      : generatePruneVariant(sections, variantName);
  const results = await runSuite(BENCHMARK_CASES, variant, caller, runnerConfig);
  const agg = aggregateResults(results);

  console.log('\n═══ Benchmark Results ═══');
  console.log(`Pass rate:        ${(agg.passRate * 100).toFixed(1)}%`);
  console.log(`Rule compliance:  ${(agg.avgRuleCompliance * 100).toFixed(1)}%`);
  console.log(`Tool accuracy:    ${(agg.avgToolAccuracy * 100).toFixed(1)}%`);
  console.log(`Avg tokens:       ${agg.avgTokenEfficiency.toFixed(0)}`);
  console.log(`Conciseness:      ${(agg.avgConciseness * 100).toFixed(1)}%`);

  if (agg.topViolations.length > 0) {
    console.log('\nTop violations:');
    for (const v of agg.topViolations) {
      console.log(`  ${v.count}x  ${v.rule}`);
    }
  }

  const reportPath = resolve(config.outputDir, `bench-${slugifyModel(model)}-${Date.now()}.json`);
  writeFileSync(
    reportPath,
    JSON.stringify({ experiment: 'raw-template', aggregate: agg, results }, null, 2),
  );
  console.log(`\nFull report: ${reportPath}`);
}

async function main(argv: readonly string[] = process.argv.slice(2)) {
  const args: CliArgs = parseArgs(argv);
  const command = args.command;
  const config = loadConfig();
  const isDryRun = args.dryRun;
  const requestedModel = args.model ?? config.defaultModel;
  const model = resolveModel(requestedModel);

  const runnerConfig: RunnerConfig = {
    model,
    apiBaseUrl: config.apiBaseUrl,
    apiKey: process.env[config.apiKeyEnvVar] ?? '',
    concurrency: config.concurrency,
  };

  // Resolve caller: real API if key available and not --dry-run, otherwise dry-run
  const credentials = credentialStateFor(runnerConfig, isDryRun);
  const hasApiKey = credentials.apiKey.length > 0;
  const caller = isDryRun || !hasApiKey ? dryRunCaller : realCaller;

  if (!isDryRun && !hasApiKey) {
    console.warn('Warning: No API key found, falling back to dry-run mode.');
    console.warn('  Checked: KIMI_API_KEY, KIMI_MODEL_API_KEY, ~/.kimi-code/config.toml');
    if (credentials.error !== undefined) console.warn(`  ${credentials.error}`);
  }

  // A dry run answers every case with the same text regardless of the prompt, so
  // nothing it reports is evidence about the prompt. Say so before the numbers.
  if (isDryRun && (command === 'prune' || command === 'ab')) {
    console.warn(
      'Note: dry-run — responses do not depend on the prompt, so the scores below\n' +
        '      compare nothing. Run without --dry-run to get a verdict.',
    );
  }

  const outputDir = config.outputDir;
  mkdirSync(outputDir, { recursive: true });

  switch (command) {
    case 'bench': {
      // `--compare` and a prune `--variant` both operate on the raw template, so
      // they are the explicit experiment rather than the default input.
      if (args.compare !== undefined || args.variant !== undefined) {
        await benchRawTemplate({ args, config, runnerConfig, caller, model, dryRun: isDryRun });
        break;
      }
      await benchRendered({
        args,
        config,
        runnerConfig,
        caller,
        model,
        dryRun: isDryRun,
        credentials,
      });
      break;
    }

    case 'prune': {
      console.log(`Running pruner (model: ${model}, dry-run: ${isDryRun})`);
      const { sections } = loadPrompt(config.systemPromptPath);

      const report = await runPruner(sections, BENCHMARK_CASES, {
        significanceThreshold: 0.1,
        runner: runnerConfig,
        caller,
      });

      console.log('\n' + formatPruneReport(report));

      const reportPath = resolve(outputDir, `prune-${slugifyModel(model)}-${Date.now()}.json`);
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`\nFull report: ${reportPath}`);
      break;
    }

    case 'ab': {
      const { sections } = loadPrompt(config.systemPromptPath);
      // Variants come from --variant, not from a hardcoded edit of the prompt
      // text: a hardcoded edit silently produces two identical variants once
      // that text changes.
      const variants = buildVariants(sections, args.variants);
      console.log(
        `Running A/B test (model: ${model}, variants: ${variants.map((v) => v.name).join(' vs ')}, dry-run: ${isDryRun})`,
      );

      const result = await runABExperiment(
        {
          name: 'ab',
          targetSections: variants.flatMap((v) => v.modifiedSections),
          variants,
          caseFilter: 'all',
          repetitions: 1,
          model,
        },
        { runner: runnerConfig, caller },
      );

      console.log('\n' + formatABReport(result));

      const reportPath = resolve(outputDir, `ab-${slugifyModel(model)}-${Date.now()}.json`);
      writeFileSync(
        reportPath,
        JSON.stringify(
          { ...result, variantResults: Object.fromEntries(result.variantResults) },
          null,
          2,
        ),
      );
      console.log(`\nFull report: ${reportPath}`);
      break;
    }

    case 'probe': {
      const reps = args.reps;
      console.log(`Running model probe (model: ${model}, reps: ${reps}, dry-run: ${isDryRun})`);

      const profile = await runProbe({
        runner: runnerConfig,
        caller,
        repetitions: reps,
      });

      console.log('\n' + formatProbeReport(profile));

      const reportPath = resolve(outputDir, `probe-${slugifyModel(model)}-${Date.now()}.json`);
      writeFileSync(reportPath, JSON.stringify(profile, null, 2));
      console.log(`\nFull report: ${reportPath}`);
      break;
    }

    default:
      console.log(`Prompt Optimizer — Data-driven prompt optimization for kimi-code

Commands:
  bench   Render a production profile and evaluate it (default input)
  prune   Scan for removable sections (raw system.md template)
  ab      A/B test raw-template prompt variants
  probe   Profile model capabilities and weaknesses

Options:
  --model <name>            Model to test (default: ${config.defaultModel || 'config.toml default_model'})
  --profile <name>          Profile to render: ${PROMPT_PROFILES.join(' | ')} (default: full)
  --actual-global <path>    Opt in to the one authorized global AGENTS.md; any other path is refused
  --compare <a,b>           Raw-template experiment: compare prune variants of system.md
  --variant <name>          Raw-template experiment: one prune variant (base | prune:<Section>)
  --dry-run                 Run without API calls (framework check, never a verdict)
  --reps <n>                Repetitions for probe (default: 3)

Examples:
  bun src/cli.ts bench --dry-run --profile full --model kimi-k3-1
  bun src/cli.ts bench --profile deepseek-adapted --model deepseek-v4-pro
  bun src/cli.ts bench --compare base,prune:Coding --dry-run --model kimi-k3-1
  bun src/cli.ts prune --model gpt-4o
  bun src/cli.ts probe --model deepseek-v3 --reps 5`);
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    // An argument mistake is the user's typo, not a crash: show the message and
    // the usage line without a stack trace.
    if (error instanceof CliArgError || error instanceof VariantSpecError) {
      console.error(`Error: ${error.message}`);
      process.exit(2);
    }
    if (error instanceof RenderedPromptError) {
      console.error(`Error [${error.code}]: ${error.message}`);
      process.exit(2);
    }
    if (error instanceof ContractCoverageError) {
      printContractBlockers(error);
      process.exit(GATE_FAILURE_EXIT_CODE);
    }
    console.error('Error:', error);
    process.exit(1);
  });
}
