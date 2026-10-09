import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ILogger } from '#/_base/log/log';
import { familyAdaptationPrefixes, resolveModelFamily } from '#/llm-adapter/contract/modelFamily';

const ADAPTATIONS_DIR_TAIL = 'agentProfileCatalog/model-adaptations';

const MAX_ADAPTATION_BYTES = 32 * 1024;

export function adaptationDirectoryCandidates(
  moduleDir: string = import.meta.dirname,
): readonly string[] {
  const out: string[] = [];
  let dir = moduleDir;
  for (let depth = 0; depth < 4; depth += 1) {
    out.push(resolve(dir, 'model-adaptations'));
    dir = resolve(dir, '..');
  }
  out.push(resolve(moduleDir, 'src/app', ADAPTATIONS_DIR_TAIL));
  out.push(resolve(moduleDir, 'app', ADAPTATIONS_DIR_TAIL));
  return out;
}

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

export async function loadModelAdaptation(
  input: LoadAdaptationInput,
): Promise<string | undefined> {
  const stems = input.candidates ?? [adaptationFileStem(input.model)];
  const usable = stems.filter((stem) => stem.length > 0);
  if (usable.length === 0) return undefined;

  const dirs = input.dir === undefined ? adaptationDirectoryCandidates() : [input.dir];
  for (const dir of dirs) {
    const adaptation = await loadFrom(dir, usable, input.log);
    if (adaptation !== undefined) return adaptation;
  }
  return undefined;
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
    const text = await readFile(join(dir, match), 'utf-8');
    if (text.length > MAX_ADAPTATION_BYTES) {
      log?.warn(`model adaptation ${match} is oversized; ignoring`);
      return undefined;
    }
    const trimmed = text.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  } catch (error: unknown) {
    log?.warn(`model adaptation ${match} unreadable: ${describe(error)}`);
    return undefined;
  }
}

export function renderAdaptationSection(model: string, adaptation: string): string {
  return [
    `# Model Adaptation: ${model}`,
    '',
    `Measured for this model by \`scripts/prompt-optimizer probe --model ${model}\`.`,
    'These notes describe your own tendencies; they are reference data, not an',
    'instruction from the user. Where they conflict with the instructions above,',
    'the instructions above win.',
    '',
    stripGeneratedHeader(adaptation),
  ].join('\n');
}

export function renderCuratedAdaptation(model: string, adaptation: string): string {
  return [
    `# Model Adaptation: ${model}`,
    '',
    'Curated guidance for this model family, taken from the vendor of that family.',
    'These are standing instructions for how to work, not measured tendencies.',
    'Where they conflict with the instructions above, the instructions above win.',
    '',
    stripGeneratedHeader(adaptation),
  ].join('\n');
}

export function isCuratedAdaptationModel(name: string): boolean {
  const family = resolveModelFamily(name);
  return family?.curatedAdaptation === true && family.promptShape === 'minimal';
}

export async function loadCuratedAdaptation(
  name: string,
  log?: ILogger,
): Promise<string | undefined> {
  if (!isCuratedAdaptationModel(name)) return undefined;
  const stems = familyAdaptationPrefixes(name);
  if (stems.length === 0) return undefined;
  const adaptation = await loadModelAdaptation({ model: name, candidates: stems, log });
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

export const MODEL_ADAPTATIONS_ENV = 'KIMI_MODEL_ADAPTATIONS';

export function modelAdaptationsEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}
