import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { ILogger } from '#/_base/log/log';
import { familyAdaptationPrefixes, resolveModelFamily } from '#/llm-adapter/contract/modelFamily';

import DEEPSEEK_ADAPTATION from './model-adaptations/curated/deepseek.md?raw';

const MAX_ADAPTATION_BYTES = 32 * 1024;

const BUILTIN_ADAPTATIONS: Readonly<Record<string, string>> = {
  deepseek: DEEPSEEK_ADAPTATION,
};

export function adaptationFileStem(model: string): string {
  const tail = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return tail
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
}

export interface LoadAdaptationInput {
  readonly model: string;
  readonly candidates?: readonly string[];
  readonly log?: ILogger;
  readonly dir?: string;
}

export async function loadModelAdaptation(input: LoadAdaptationInput): Promise<string | undefined> {
  const stems =
    input.candidates ??
    (input.dir === undefined
      ? familyAdaptationPrefixes(input.model)
      : [adaptationFileStem(input.model)]);
  const usable = stems.filter((stem) => stem.length > 0);
  if (usable.length === 0) return undefined;

  if (input.dir === undefined) {
    for (const stem of usable) {
      const builtin = BUILTIN_ADAPTATIONS[stem];
      if (builtin !== undefined) return clampAdaptation(builtin, stem, input.log);
    }
    return undefined;
  }
  return loadFrom(input.dir, usable, input.log);
}

function clampAdaptation(text: string, stem: string, log: ILogger | undefined): string | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  if (trimmed.length <= MAX_ADAPTATION_BYTES) return trimmed;
  const truncated = truncateAtSection(trimmed, MAX_ADAPTATION_BYTES);
  log?.warn(
    `model adaptation ${stem}.md exceeds ${MAX_ADAPTATION_BYTES} bytes; truncated to ${truncated.length}`,
  );
  return truncated;
}

async function loadFrom(
  dir: string,
  stems: readonly string[],
  log: ILogger | undefined,
): Promise<string | undefined> {
  let names: readonly string[];
  try {
    names = await readdir(dir);
  } catch (error: unknown) {
    const code = (error as { code?: unknown } | null)?.code;
    if (code !== 'ENOENT') {
      log?.warn(`model adaptations directory unreadable: ${describe(error)}`);
    }
    return undefined;
  }

  const byLowerName = new Map(names.map((name) => [name.toLowerCase(), name]));
  let match: string | undefined;
  for (const stem of stems) {
    const found = byLowerName.get(`${stem}.md`);
    if (found !== undefined) {
      match = found;
      break;
    }
  }
  if (match === undefined) return undefined;

  try {
    const text = await Bun.file(join(dir, match)).text();
    return clampAdaptation(text, match.replace(/\.md$/, ''), log);
  } catch (error: unknown) {
    log?.warn(`model adaptation ${match} unreadable: ${describe(error)}`);
    return undefined;
  }
}

export function truncateAtSection(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const boundaries: number[] = [];
  const fenceSpans: { start: number; end: number }[] = [];
  let fence: string | undefined;
  let openFenceAt = -1;
  const lines = text.split('\n');
  let offset = 0;
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fenceMatch !== null) {
      const marker = fenceMatch[1]!;
      if (fence === undefined) {
        fence = marker[0];
        openFenceAt = offset;
      } else if (marker[0] === fence) {
        fence = undefined;
        fenceSpans.push({ start: openFenceAt, end: offset + line.length });
        openFenceAt = -1;
      }
    } else if (fence === undefined && /^##\s/.test(line)) {
      boundaries.push(offset);
    }
    offset += line.length + 1;
  }
  if (openFenceAt >= 0) fenceSpans.push({ start: openFenceAt, end: offset });

  let cut = -1;
  for (const boundary of boundaries) {
    if (boundary === 0) continue;
    if (boundary <= limit) cut = boundary;
    else break;
  }
  if (cut > 0) return text.slice(0, cut).trimEnd();

  const enclosing = fenceSpans.find(
    (span) => span.start > 0 && span.start < limit && limit < span.end,
  );
  const safeLimit = enclosing === undefined ? limit : Math.min(limit, enclosing.start);
  return text.slice(0, safeLimit).trimEnd();
}

export const DEEPSEEK_ADAPTATION_SOURCE_ID =
  'packages/agent-core-v2/src/app/agentProfileCatalog/model-adaptations/curated/deepseek.md';

export function renderCuratedAdaptation(model: string, adaptation: string): string {
  return [
    `# Model Adaptation: ${model}`,
    '',
    'Curated guidance for this model family, authored for this repository and hand-written.',
    'These are standing instructions for how to work, not measured tendencies and not model probes.',
    'Where they conflict with the instructions above, the instructions above win.',
    '',
    stripGeneratedHeader(adaptation),
  ].join('\n');
}

export function hasCuratedAdaptation(name: string): boolean {
  return resolveModelFamily(name)?.curatedAdaptation === true;
}

export async function loadCuratedAdaptation(
  name: string,
  log?: ILogger,
): Promise<string | undefined> {
  if (!hasCuratedAdaptation(name)) return undefined;
  const stems = familyAdaptationPrefixes(name);
  if (stems.length === 0) return undefined;
  const adaptation = await loadModelAdaptation({
    model: name,
    candidates: stems,
    log,
  });
  return adaptation === undefined ? undefined : renderCuratedAdaptation(name, adaptation);
}

function stripGeneratedHeader(adaptation: string): string {
  const lines = adaptation.split('\n');
  let index = 0;
  if (lines[index]?.startsWith('# Model Adaptation:')) index += 1;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    const isProvenanceComment = /^#(\s|$)/.test(line) && !line.startsWith('##');
    if (line.trim().length === 0 || isProvenanceComment) {
      index += 1;
      continue;
    }
    break;
  }
  return lines.slice(index).join('\n').trim();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
