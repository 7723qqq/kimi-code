// apps/kimi-web/src/lib/toolMeta.ts
// Helpers for tool display. Labels/chips are localized via the shared i18n instance.

import { i18n } from '../i18n';

const t = i18n.global.t;

// ---------------------------------------------------------------------------
// toolLabel: human-readable, localized label for a tool name
// ---------------------------------------------------------------------------

const TOOL_LABEL_KEYS: Record<string, string> = {
  read: 'tools.label.read',
  bash: 'tools.label.bash',
  edit: 'tools.label.edit',
  write: 'tools.label.write',
  grep: 'tools.label.grep',
  glob: 'tools.label.glob',
  web_fetch: 'tools.label.web_fetch',
  search: 'tools.label.search',
};

export function toolLabel(name: string): string {
  const key = TOOL_LABEL_KEYS[name];
  return key ? t(key) : name;
}

// ---------------------------------------------------------------------------
// toolGlyph: a small inline SVG string (viewBox="0 0 16 16") or short glyph
// Each returns an <svg> string suitable for v-html in a 14×14 container,
// OR a plain Unicode glyph string when SVG would be excessive.
// ---------------------------------------------------------------------------

const GLYPH_READ = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><rect x="2.5" y="1.5" width="9" height="13" rx="1"/><line x1="5" y1="5" x2="9" y2="5"/><line x1="5" y1="7.5" x2="11" y2="7.5"/><line x1="5" y1="10" x2="10" y2="10"/></svg>`;
const GLYPH_BASH = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><polyline points="4,6 6.5,8 4,10"/><line x1="8" y1="10" x2="12" y2="10"/></svg>`;
const GLYPH_EDIT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z"/><line x1="8.5" y1="4.5" x2="11.5" y2="7.5"/></svg>`;
const GLYPH_WRITE = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><path d="M3 12V4.5L8 2l5 2.5V12H3z"/><line x1="6" y1="7" x2="10" y2="7"/><line x1="8" y1="5" x2="8" y2="9"/></svg>`;
const GLYPH_GREP = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="4"/><line x1="9.5" y1="9.5" x2="13.5" y2="13.5"/></svg>`;
const GLYPH_GLOB = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="6.5" cy="6.5" r="4"/><path d="M10 10l3 3"/><line x1="4" y1="6.5" x2="9" y2="6.5"/><line x1="6.5" y1="4" x2="6.5" y2="9"/></svg>`;
const GLYPH_WEB = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><circle cx="8" cy="8" r="6"/><path d="M8 2c-2 2-3 3.6-3 6s1 4 3 6"/><path d="M8 2c2 2 3 3.6 3 6s-1 4-3 6"/><line x1="2" y1="8" x2="14" y2="8"/></svg>`;
const GLYPH_DEFAULT = `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" xmlns="http://www.w3.org/2000/svg"><polygon points="5,2 11,8 5,14"/></svg>`;

export function toolGlyph(name: string): string {
  switch (name) {
    case 'read':      return GLYPH_READ;
    case 'bash':      return GLYPH_BASH;
    case 'edit':      return GLYPH_EDIT;
    case 'write':     return GLYPH_WRITE;
    case 'grep':      return GLYPH_GREP;
    case 'glob':      return GLYPH_GLOB;
    case 'web_fetch': return GLYPH_WEB;
    case 'search':    return GLYPH_GREP;
    default:          return GLYPH_DEFAULT;
  }
}

// ---------------------------------------------------------------------------
// toolChip: short stat string derived from tool output / arguments
// Defensive: never throws.
// ---------------------------------------------------------------------------

export interface ToolChipInput {
  name: string;
  arg: string;
  output?: string[];
  timing?: string;
  status?: string;
}

// ---------------------------------------------------------------------------
// toolSummary: a concise, per-tool-kind header string derived from the tool's
// arguments (`arg` holds the JSON-stringified tool input, or a plain string).
// Read → path + line range, Write/Edit → path, Bash → command (truncated),
// Grep/Search → pattern, Glob/LS → path/pattern, Fetch → host/url.
// Falls back to the raw arg for unknown tools. Defensive: never throws.
// ---------------------------------------------------------------------------

const SUMMARY_MAX = 80;

function clip(s: string, max = SUMMARY_MAX): string {
  const trimmed = s.trim();
  return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
}

/** Parse the JSON-stringified `arg` into a record, or null for plain strings. */
function parseArg(arg: string): Record<string, unknown> | null {
  const s = arg.trim();
  if (!s.startsWith('{')) return null;
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Reduce a URL to "host[/first-segment]" for a compact fetch summary. */
function urlHost(url: string): string {
  try {
    const u = new URL(url);
    const seg = u.pathname.split('/').filter(Boolean)[0];
    return seg ? `${u.host}/${seg}` : u.host;
  } catch {
    return url.replace(/^https?:\/\//, '');
  }
}

export function toolSummary(name: string, arg: string): string {
  try {
    const d = parseArg(arg);
    // Plain-string arg (already a human string) — just clip it.
    const fallback = () => clip(arg.replace(/^·\s*/, ''));
    if (!d) return fallback();

    switch (name) {
      case 'read': {
        const path = str(d.path) ?? str(d.file_path);
        if (!path) return fallback();
        const start = num(d.offset) ?? num(d.line_start) ?? num(d.start_line);
        const len = num(d.limit) ?? num(d.length);
        const end = num(d.line_end) ?? num(d.end_line) ?? (start !== undefined && len !== undefined ? start + len : undefined);
        if (start !== undefined && end !== undefined) return clip(`${path}:${start}-${end}`);
        if (start !== undefined) return clip(`${path}:${start}`);
        return clip(path);
      }
      case 'write':
      case 'edit': {
        const path = str(d.path) ?? str(d.file_path);
        return path ? clip(path) : fallback();
      }
      case 'bash': {
        const cmd = str(d.command) ?? str(d.cmd);
        return cmd ? clip(cmd) : fallback();
      }
      case 'grep':
      case 'search': {
        const pattern = str(d.pattern) ?? str(d.query) ?? str(d.regex);
        const path = str(d.path) ?? str(d.glob);
        if (pattern && path) return clip(`${pattern}  in ${path}`);
        return pattern ? clip(pattern) : fallback();
      }
      case 'glob': {
        const pattern = str(d.pattern) ?? str(d.glob) ?? str(d.path);
        return pattern ? clip(pattern) : fallback();
      }
      case 'web_fetch': {
        const url = str(d.url);
        return url ? clip(urlHost(url)) : fallback();
      }
      default:
        return fallback();
    }
  } catch {
    return arg;
  }
}

export function toolChip(tool: ToolChipInput): string {
  try {
    switch (tool.name) {
      case 'bash': {
        // Prefer timing if present
        if (tool.timing) return tool.timing;
        return '';
      }
      case 'read': {
        // Count output lines
        if (tool.output && tool.output.length > 0) {
          const count = tool.output.length;
          return t('tools.chip.lines', { count });
        }
        return '';
      }
      case 'edit':
      case 'write': {
        // Try to parse +A −B from output (unified diff summary)
        if (tool.output) {
          for (const line of tool.output) {
            const m = line.match(/\+(\d+).*[-−](\d+)/);
            if (m) return `+${m[1]} −${m[2]}`;
          }
          // Also check for simple "N lines" style
          const summary = tool.output.find(l => /\d+/.test(l));
          if (summary) {
            const addMatch = summary.match(/\+(\d+)/);
            const remMatch = summary.match(/[-−](\d+)/);
            if (addMatch || remMatch) {
              return `${addMatch ? `+${addMatch[1]}` : ''} ${remMatch ? `−${remMatch[1]}` : ''}`.trim();
            }
          }
          // Succeeded but no diff counts available → just signal "edited".
          if (tool.status !== 'error') return t('tools.chip.edited');
        }
        return '';
      }
      case 'grep':
      case 'search': {
        if (tool.output && tool.output.length > 0) {
          return t('tools.chip.results', { count: tool.output.length });
        }
        return '';
      }
      default:
        return '';
    }
  } catch {
    return '';
  }
}
