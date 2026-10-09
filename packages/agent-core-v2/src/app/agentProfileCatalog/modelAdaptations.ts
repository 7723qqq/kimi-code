import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import type { ILogger } from '#/_base/log/log';
import { familyAdaptationPrefixes, resolveModelFamily } from '#/llm-adapter/contract/modelFamily';

export type AdaptationKind = 'curated' | 'measured';

const ADAPTATIONS_DIR_TAIL = 'agentProfileCatalog/model-adaptations';

const MAX_ADAPTATION_BYTES = 32 * 1024;

export function adaptationDirectoryCandidates(
  moduleDir: string = import.meta.dirname,
  kind: AdaptationKind = 'measured',
): readonly string[] {
  const out: string[] = [];
  let dir = moduleDir;
  for (let depth = 0; depth < 4; depth += 1) {
    out.push(resolve(dir, 'model-adaptations', kind));
    dir = resolve(dir, '..');
  }
  out.push(resolve(moduleDir, 'src/app', ADAPTATIONS_DIR_TAIL, kind));
  out.push(resolve(moduleDir, 'app', ADAPTATIONS_DIR_TAIL, kind));
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
  readonly kind?: AdaptationKind;
}

export async function loadModelAdaptation(
  input: LoadAdaptationInput,
): Promise<string | undefined> {
  const stems = input.candidates ?? [adaptationFileStem(input.model)];
  const usable = stems.filter((stem) => stem.length > 0);
  if (usable.length === 0) return undefined;

  const dirs =
    input.dir === undefined
      ? adaptationDirectoryCandidates(import.meta.dirname, input.kind ?? 'measured')
      : [input.dir];
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
    const trimmed = text.trim();
    if (trimmed.length === 0) return undefined;
    if (trimmed.length > MAX_ADAPTATION_BYTES) {
      // Truncate at a section boundary rather than dropping the file. These
      // files are hand-written and split by `##`, so cutting at one keeps whole
      // guidance sections instead of discarding all of them; silently losing the
      // entire adaptation because the last paragraph ran long is the worse
      // failure of the two.
      const truncated = truncateAtSection(trimmed, MAX_ADAPTATION_BYTES);
      log?.warn(
        `model adaptation ${match} exceeds ${MAX_ADAPTATION_BYTES} bytes; truncated to ${truncated.length}`,
      );
      return truncated;
    }
    return trimmed;
  } catch (error: unknown) {
    log?.warn(`model adaptation ${match} unreadable: ${describe(error)}`);
    return undefined;
  }
}

/**
 * Keep as many leading `##` sections as fit in `limit`.
 *
 * Falls back to a hard cut only when even the first section does not fit, so a
 * caller always gets the beginning of the file — which is where the most
 * important guidance sits in practice — rather than nothing.
 *
 * A `##` line inside a fenced code block is content, not a section boundary:
 * these files quote example prompts in fences, and treating a quoted heading as
 * a boundary could cut inside the block, leaving the fence unterminated and the
 * remainder of the guidance framed as code. Fences are tracked so only real
 * headings split the file. Indented code blocks need no handling — their lines
 * start with whitespace and cannot match a heading at all.
 */
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
        // Record the span, not just the open offset: the cut has to be able to
        // ask "does the limit fall inside *this* fence", including one that
        // closes further down the file.
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

  // Hard cut. If the limit lands inside a fence the result would swallow
  // everything after it as code, so start the cut at the fence opening instead.
  // A fence that opens at the very beginning leaves nothing to keep, so that
  // case falls through to the plain cut rather than returning an empty string.
  const enclosing = fenceSpans.find((span) => span.start > 0 && span.start < limit && limit < span.end);
  const safeLimit = enclosing === undefined ? limit : Math.min(limit, enclosing.start);
  return text.slice(0, safeLimit).trimEnd();
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

/**
 * The single resolution order for model adaptation text, shared by the system
 * prompt path and the reminder-injection path so the two can never disagree
 * about which file a model receives.
 *
 * Measured probe output is opt-in and outranks the curated family file when
 * enabled: it is the more specific artefact and the `measured/` directory does
 * not load at all without the flag. With the flag off, only the curated family
 * guidance is reachable.
 */
export async function resolveModelAdaptationText(input: {
  readonly model: string;
  readonly candidates?: readonly string[];
  readonly optIn: string | undefined;
  readonly log?: ILogger;
}): Promise<string | undefined> {
  if (modelAdaptationsEnabled(input.optIn)) {
    const measured = await loadModelAdaptation({
      model: input.model,
      candidates: input.candidates ?? [adaptationFileStem(input.model)],
      log: input.log,
      kind: 'measured',
    });
    if (measured !== undefined) return renderAdaptationSection(input.model, measured);
  }
  return loadCuratedAdaptation(input.model, input.log);
}

export async function loadCuratedAdaptation(
  name: string,
  log?: ILogger,
): Promise<string | undefined> {
  if (!isCuratedAdaptationModel(name)) return undefined;
  const stems = familyAdaptationPrefixes(name);
  if (stems.length === 0) return undefined;
  const adaptation = await loadModelAdaptation({
    model: name,
    candidates: stems,
    log,
    kind: 'curated',
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

export const MODEL_ADAPTATIONS_ENV = 'KIMI_MODEL_ADAPTATIONS';

export function modelAdaptationsEnabled(raw: string | undefined): boolean {
  return raw === '1' || raw === 'true';
}
