/**
 * Prompt Optimizer — CLI entry point.
 *
 * Usage:
 *   bun src/cli.ts bench [--model <model>] [--variant <name>] [--dry-run]
 *   bun src/cli.ts prune [--model <model>] [--dry-run]
 *   bun src/cli.ts ab    [--model <model>] [--experiment <file>] [--dry-run]
 *   bun src/cli.ts probe [--model <model>] [--reps <n>] [--dry-run]
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { formatABReport, runABExperiment } from './ab-test/ab-test';
import { VariantSpecError, buildVariants } from './ab-test/variants';
import { BENCHMARK_CASES } from './benchmark/cases';
import { runSuite, aggregateResults, dryRunCaller, type RunnerConfig } from './benchmark/runner';
import { loadConfig } from './config';
import { realCaller, resolveCredentials, resolveModel } from './llm-caller';
import { runProbe, formatProbeReport } from './probe/probe';
import { loadPrompt, generateBaselineVariant, generatePruneVariant } from './prompt-parser';
import { runPruner, formatPruneReport } from './pruner/pruner';
import { generateComparisonReport, type CompareInput } from './report/report';
import { parseArgs, CliArgError, type CliArgs } from './cli-args';

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
  const resolved = resolveCredentials(runnerConfig);
  const hasApiKey = resolved.apiKey.length > 0;
  const caller = isDryRun || !hasApiKey ? dryRunCaller : realCaller;

  if (!isDryRun && !hasApiKey) {
    console.warn('Warning: No API key found, falling back to dry-run mode.');
    console.warn('  Checked: KIMI_API_KEY, KIMI_MODEL_API_KEY, ~/.kimi-code/config.toml');
  }

  // A dry run answers every case with the same text regardless of the prompt, so
  // nothing it reports is evidence about the prompt. Say so before the numbers.
  if (isDryRun && (command === 'prune' || command === 'ab' || command === 'bench')) {
    console.warn(
      'Note: dry-run — responses do not depend on the prompt, so the scores below\n' +
        '      compare nothing. Run without --dry-run to get a verdict.',
    );
  }

  const outputDir = config.outputDir;
  mkdirSync(outputDir, { recursive: true });

  switch (command) {
    case 'bench': {
      const compareArg = args.compare;
      const { sections } = loadPrompt(config.systemPromptPath);

      if (compareArg) {
        // --compare mode: run multiple variants and compare
        const variantNames = compareArg.split(',');
        console.log(
          `Comparing variants: ${variantNames.join(' vs ')} (model: ${model}, dry-run: ${isDryRun})`,
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

        const reportPath = resolve(outputDir, `compare-${slugifyModel(model)}-${Date.now()}.json`);
        writeFileSync(
          reportPath,
          JSON.stringify(
            compareInputs.map((c) => ({ name: c.name, aggregate: aggregateResults(c.results) })),
            null,
            2,
          ),
        );
        console.log(`\nFull report: ${reportPath}`);
      } else {
        // Single variant mode
        const variantName = args.variant ?? 'base';
        console.log(
          `Running benchmark suite (${BENCHMARK_CASES.length} cases, model: ${model}, variant: ${variantName}, dry-run: ${isDryRun})`,
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

        const reportPath = resolve(outputDir, `bench-${slugifyModel(model)}-${Date.now()}.json`);
        writeFileSync(reportPath, JSON.stringify({ aggregate: agg, results }, null, 2));
        console.log(`\nFull report: ${reportPath}`);
      }
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
  bench   Run the benchmark suite against current system.md
  prune   Scan for removable sections (prompt pruning)
  ab      A/B test prompt variants
  probe   Profile model capabilities and weaknesses

Options:
  --model <name>    Model to test (default: ${config.defaultModel})
  --dry-run         Run without API calls (test framework only)
  --reps <n>        Repetitions for probe (default: 3)

Examples:
  bun src/cli.ts bench --dry-run
  bun src/cli.ts prune --model gpt-4o
  bun src/cli.ts probe --model deepseek-v3 --reps 5
  bun src/cli.ts ab --dry-run`);
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
    console.error('Error:', error);
    process.exit(1);
  });
}
