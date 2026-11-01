/**
 * Prompt Optimizer — Prompt parser.
 *
 * The production prompt is no longer one file. `system.md` is a skeleton that
 * carries `${coding_section}`, `${delivering_work_section}` and
 * `${agents_section}`; each expands to a standalone section file beside it
 * (`coding.md`, `delivering-work.md` / `delivering-work-read-only.md`,
 * `project-information.md`). Scanning the skeleton alone therefore sees only
 * what was left behind, so `loadPromptBundle` splices the section files in
 * before parsing and prune measures the text the agent actually receives.
 *
 * The spliced text is a section-level reconstruction for scanning, not a
 * render: placeholders such as `${reply_style_guide}` are filled with the same
 * neutral default the renderer uses for them so the result never depends on the
 * fixture. `renderProfile` remains the only production-shaped input.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import type { PromptSection, PromptSectionBundle, PromptVariant } from './types';

/**
 * Rough token estimation: ~4 chars per token for English,
 * ~2 chars per token for CJK. Good enough for relative comparison.
 */
export function estimateTokens(text: string): number {
  let count = 0;
  for (const char of text) {
    count += char.charCodeAt(0) > 0x4e00 ? 0.5 : 0.25;
  }
  return Math.ceil(count);
}

/**
 * Parse a markdown prompt into sections by heading level.
 * Splits at lines starting with `#` (any level).
 */
export function parsePromptSections(content: string): PromptSection[] {
  const lines = content.split('\n');
  const sections: PromptSection[] = [];
  let currentHeading = '(preamble)';
  let currentStart = 0;
  let currentLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#{1,3}\s/.test(line) && i > 0) {
      const sectionContent = currentLines.join('\n');
      sections.push({
        heading: currentHeading,
        content: sectionContent,
        tokens: estimateTokens(sectionContent),
        startLine: currentStart + 1,
        endLine: i,
      });
      currentHeading = line.replace(/^#+\s*/, '').trim();
      currentStart = i;
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }

  if (currentLines.length > 0) {
    const sectionContent = currentLines.join('\n');
    sections.push({
      heading: currentHeading,
      content: sectionContent,
      tokens: estimateTokens(sectionContent),
      startLine: currentStart + 1,
      endLine: lines.length,
    });
  }

  return sections;
}

/**
 * Attribute each section to the file it was spliced from.
 *
 * The splice inserts `\n<file text trimmed>\n` per section file, so every
 * section body appears verbatim in exactly one source — once the section file's
 * own placeholders are resolved the same way the assembled text resolves them
 * (`${plan_mode_guidance}`, `${agents_md}`, …). Matching on the heading alone is
 * not enough: `delivering-work.md` and its read-only variant share
 * `# Delivering work`, so the comparison uses the body.
 */
function attributeSections(
  sections: readonly PromptSection[],
  skeletonPath: string,
  sectionFiles: readonly string[],
  vars: Record<string, string>,
): PromptSection[] {
  const bodies = sectionFiles.map((path) => ({
    path,
    text: applyVars(readFileSync(path, 'utf-8').trim(), vars),
  }));
  return sections.map((section) => {
    const match = bodies.find((body) => section.content.includes(body.text));
    return match === undefined
      ? { ...section, sourceFile: skeletonPath }
      : { ...section, sourceFile: match.path };
  });
}

function applyVars(text: string, vars: Record<string, string>): string {
  let out = text;
  for (const [name, value] of Object.entries(vars)) {
    out = out.replaceAll(`\${${name}}`, value);
  }
  return out;
}

/**
 * Load and parse a system prompt file.
 */
export function loadPrompt(path: string): { raw: string; sections: PromptSection[] } {
  const raw = readFileSync(path, 'utf-8');
  return { raw, sections: parsePromptSections(raw) };
}

/**
 * Section placeholders the skeleton delegates to a standalone file.
 *
 * The read-only variants are listed after their full counterparts so a
 * `readOnly` bundle reports the file it actually ships, and the two are never
 * merged: a profile receives one or the other, never both.
 *
 * `coding_section` has no read-only file because `profile-shared.ts` renders it
 * empty for those profiles (read-only agents do not change code), so the bundle
 * drops it entirely rather than splicing text the agent never receives.
 */
const SECTION_SOURCES: Readonly<
  Record<string, { readonly full: string; readonly readOnly?: string | null }>
> = {
  coding_section: { full: 'coding.md', readOnly: null },
  delivering_work_section: { full: 'delivering-work.md', readOnly: 'delivering-work-read-only.md' },
  agents_section: { full: 'project-information.md' },
};

/**
 * Default values for the remaining placeholders, matching what the production
 * renderer supplies when a fixture omits them.
 *
 * Splicing must not change a section's measured size when only the fixture
 * changed, so a placeholder resolves to the same neutral text here as it does in
 * `systemPromptVars` with an empty context.
 */
const NEUTRAL_VARS: Readonly<Record<string, string>> = {
  product_name: 'Kimi Code CLI',
  role_additional: '',
  behavior_contract: '',
  reply_style_guide: '',
  notify_user_guidance: '',
  coding_section: '',
  delivering_work_section: '',
  agents_section: '',
  plan_mode_guidance: '',
  todo_list_guidance: '',
  os: '',
  shell: '',
  windows_notes: '',
  runtime_notes: '',
  cwd: '',
  cwd_listing: '',
  additional_dirs_section: '',
  skills_section: '',
  plugin_sections: '',
  model_adaptation_section: '',
  repo_memory: '',
  agents_md: '',
  agents_md_update: '',
};

export interface LoadPromptBundleOptions {
  /** Splice `delivering-work-read-only.md` instead of `delivering-work.md`. */
  readonly readOnly?: boolean;
}

/**
 * Load the production prompt as one scannable text: the skeleton with its
 * delegated section files spliced in.
 *
 * A missing section file is a hard error rather than a silently shorter prompt:
 * the whole point of this loader is that prune sees the sections, and a rename
 * would otherwise restore the original blind spot.
 */
export function loadPromptBundle(
  skeletonPath: string,
  options: LoadPromptBundleOptions = {},
): PromptSectionBundle {
  const skeleton = readFileSync(skeletonPath, 'utf-8');
  const dir = dirname(skeletonPath);
  const readOnly = options.readOnly === true;
  const files: string[] = [];

  const resolved: Record<string, string> = {};
  for (const [placeholder, sources] of Object.entries(SECTION_SOURCES)) {
    const file = readOnly
      ? sources.readOnly === undefined
        ? sources.full
        : sources.readOnly
      : sources.full;
    if (file === null) {
      resolved[placeholder] = '';
      continue;
    }
    const path = join(dir, file);
    if (!existsSync(path)) {
      throw new Error(
        `the prompt skeleton delegates \${${placeholder}} to ${file}, which does not exist beside ` +
          `${basename(skeletonPath)} (looked in ${dir})`,
      );
    }
    resolved[placeholder] = `\n${readFileSync(path, 'utf-8').trim()}\n`;
    files.push(path);
  }

  const vars: Record<string, string> = {
    ...NEUTRAL_VARS,
    ...resolved,
    agents_md_update: readOnly
      ? ''
      : ' If you change anything an `AGENTS.md` documents, update that `AGENTS.md` to match.',
  };

  let raw = skeleton;
  for (const [name, value] of Object.entries(vars)) {
    raw = raw.replaceAll(`\${${name}}`, value);
  }

  return {
    raw,
    sections: attributeSections(parsePromptSections(raw), skeletonPath, files, vars),
    files: [skeletonPath, ...files],
    readOnly,
  };
}

/**
 * Generate a variant with a specific section removed.
 */
export function generatePruneVariant(
  sections: PromptSection[],
  removeHeading: string,
): PromptVariant {
  const remaining = sections.filter((s) => s.heading !== removeHeading);
  return {
    name: `prune:${removeHeading}`,
    description: `Removed section "${removeHeading}"`,
    content: remaining.map((s) => s.content).join('\n'),
    modifiedSections: [removeHeading],
  };
}

/**
 * Generate the baseline (unmodified) variant.
 */
export function generateBaselineVariant(sections: PromptSection[]): PromptVariant {
  return {
    name: 'baseline',
    description: 'Original unmodified prompt',
    content: sections.map((s) => s.content).join('\n'),
    modifiedSections: [],
  };
}
