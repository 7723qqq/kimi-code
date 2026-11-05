import { parseFrontmatter } from '#/_base/text/frontmatter';

import { toHardRule } from './code/rules';
import type { HardRule, MemoryCode, RecallItem } from './types';

export function codeAllowsEmbeddings(code: MemoryCode): boolean {
  return !code.rules.some((rule) => rule.action === 'block_embed');
}

export function ruleMatches(rule: HardRule, text: string): boolean {
  if (rule.regex) {
    try {
      return new RegExp(rule.pattern, 'i').test(text);
    } catch {
      return text.toLowerCase().includes(rule.pattern.toLowerCase());
    }
  }
  return text.toLowerCase().includes(rule.pattern.toLowerCase());
}

export function applyWriteRules(
  text: string,
  rules: readonly HardRule[],
): { readonly allowed: boolean; readonly matches: readonly HardRule[] } {
  const matches = rules.filter(
    (rule) => (rule.scope === 'note' || rule.scope === 'atom') && ruleMatches(rule, text),
  );
  const blocking = matches.some((rule) => rule.action === 'block_write');
  return { allowed: !blocking, matches };
}

export function applyRecallRules(
  items: readonly RecallItem[],
  rules: readonly HardRule[],
): RecallItem[] {
  return items.filter(
    (item) =>
      !rules.some(
        (rule) =>
          (rule.scope === 'recall' || rule.scope === 'atom') &&
          rule.action === 'block_recall' &&
          ruleMatches(rule, item.text),
      ),
  );
}

export function resolveConflict(
  items: readonly RecallItem[],
  rules: readonly HardRule[],
): RecallItem[] {
  const pinned = new Set(
    rules.filter((rule) => rule.action === 'pin').map((rule) => rule.pattern),
  );
  return [...items].toSorted((a, b) => {
    if (pinned.has(a.id) !== pinned.has(b.id)) return pinned.has(a.id) ? -1 : 1;
    if (a.confidence !== b.confidence) return b.confidence - a.confidence;
    return b.validFrom - a.validFrom;
  });
}

export function orderConflictGroups(
  items: readonly RecallItem[],
  rules: readonly HardRule[],
): RecallItem[] {
  const byGroup = new Map<string, RecallItem[]>();
  for (const item of items) {
    if (item.conflictGroup === undefined) continue;
    const list = byGroup.get(item.conflictGroup) ?? [];
    list.push(item);
    byGroup.set(item.conflictGroup, list);
  }
  const orderedGroups = new Map<string, readonly RecallItem[]>();
  for (const [group, entries] of byGroup) orderedGroups.set(group, resolveConflict(entries, rules));
  const seen = new Set<string>();
  const out: RecallItem[] = [];
  for (const item of items) {
    if (item.conflictGroup === undefined) {
      out.push(item);
      continue;
    }
    if (seen.has(item.conflictGroup)) continue;
    seen.add(item.conflictGroup);
    out.push(...(orderedGroups.get(item.conflictGroup) ?? []));
  }
  return out;
}

export function parseCode(content: string, defaults: MemoryCode): MemoryCode {
  let data: unknown;
  let body: string;
  try {
    const parsed = parseFrontmatter(content);
    data = parsed.data;
    body = parsed.body;
  } catch {
    return defaults;
  }
  if (typeof data !== 'object' || data === null) {
    return { rules: defaults.rules, guidance: body.trim() || defaults.guidance };
  }
  const raw = (data as { rules?: unknown }).rules;
  const rules = Array.isArray(raw)
    ? raw.map(toHardRule).filter((rule): rule is HardRule => rule !== undefined)
    : [];
  return { rules: [...defaults.rules, ...rules], guidance: body.trim() || defaults.guidance };
}
