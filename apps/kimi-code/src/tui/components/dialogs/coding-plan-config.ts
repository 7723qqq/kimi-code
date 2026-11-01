import {
  Container,
  Key,
  matchesKey,
  type Focusable,
  type TuiMouseDispatchResult,
  type TuiMouseEvent,
} from '@moonshot-ai/pi-tui';

import { t } from '#/i18n';
import { currentTheme } from '#/tui/theme';
import {
  ListMouseRouter,
  mouseDispatch,
  type ListCursor,
  type ListRowRegion,
} from '#/tui/utils/mouse';
import { printableChar, isPrintableText } from '#/tui/utils/printable-key';

export interface CodingPlanConfigOptions {
  readonly currentConfig: Record<string, unknown>;
  readonly onSave: (config: Record<string, unknown>) => void;
  readonly onCancel: () => void;
}

/** Render a config value for display in the field list. */
function displayConfigValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return JSON.stringify(value) ?? '';
}

export class CodingPlanConfigComponent extends Container implements Focusable {
  focused = false;
  private readonly opts: CodingPlanConfigOptions;
  private readonly fields: Record<string, string> = {};
  private selectedField = 0;
  private readonly fieldOrder: string[];
  private errorMsg = '';
  private readonly mouse: ListMouseRouter<string>;

  constructor(opts: CodingPlanConfigOptions) {
    super();
    this.opts = opts;
    this.fieldOrder = [
      'protocol',
      'stream',
      'temperature',
      'maxTokens',
      'enableThinking',
      'searchDisable',
      'showRefLabel',
      'loraId',
      'reasoningEffort',
    ];
    for (const key of this.fieldOrder) {
      const value = opts.currentConfig[key];
      this.fields[key] =
        value === undefined ? '' : typeof value === 'string' ? value : displayConfigValue(value);
    }
    this.mouse = new ListMouseRouter(
      this.cursor(),
      (key) => {
        const index = this.fieldOrder.indexOf(key);
        if (index >= 0) this.selectedField = index;
      },
      { isFocused: () => this.focused },
    );
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.opts.onCancel();
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.errorMsg = '';
      const config: Record<string, unknown> = {};
      for (const key of this.fieldOrder) {
        const raw = this.fields[key];
        if (raw === undefined || raw.length === 0) continue;
        const schema = FIELD_SCHEMAS[key];
        if (schema !== undefined) {
          const parsed = schema.parse(raw);
          if (schema.validate !== undefined && !schema.validate(parsed)) {
            this.errorMsg = t('tui.codingPlan.invalidValue', { key, raw });
            return;
          }
          config[key] = parsed;
        } else {
          config[key] = raw;
        }
      }
      this.opts.onSave(config);
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedField = Math.max(0, this.selectedField - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedField = Math.min(this.fieldOrder.length - 1, this.selectedField + 1);
      return;
    }
    // Type into the selected field
    if (this.selectedField >= this.fieldOrder.length) return;
    const field = this.fieldOrder[this.selectedField];
    if (field === undefined) return;
    if (matchesKey(data, Key.backspace)) {
      const current = this.fields[field];
      this.fields[field] = current !== undefined ? current.slice(0, -1) : '';
    } else {
      // Accept printable input only (including paste): arrow keys, Tab and
      // Ctrl combos must not leak escape bytes into the field value.
      const ch = printableChar(data);
      if (isPrintableText(ch)) {
        const current = this.fields[field] ?? '';
        this.fields[field] = current + ch;
      }
    }
  }

  override handleMouse(event: TuiMouseEvent): TuiMouseDispatchResult | undefined {
    return mouseDispatch(this, event, this.mouse.handleMouse(event));
  }

  private cursor(): ListCursor<string> {
    return {
      items: () => this.fieldOrder,
      selectedIndex: () => this.selectedField,
      pageCount: () => this.fieldOrder.length,
      moveTo: (index) => {
        this.selectedField = Math.max(0, Math.min(this.fieldOrder.length - 1, index));
      },
      page: (direction) => {
        this.selectedField = Math.max(
          0,
          Math.min(this.fieldOrder.length - 1, this.selectedField + direction),
        );
      },
    };
  }

  override render(width: number): string[] {
    const lines: string[] = [
      currentTheme.fg('primary', '─'.repeat(width)),
      currentTheme.boldFg('primary', t('tui.codingPlan.title')),
      '',
    ];
    const regions: ListRowRegion[] = [];
    for (let i = 0; i < this.fieldOrder.length; i++) {
      const key = this.fieldOrder[i]!;
      const label = fieldLabel(key);
      const value = this.fields[key];
      const isSelected = i === this.selectedField;
      const pointer = isSelected ? '>' : ' ';
      const field = isSelected
        ? currentTheme.boldFg('primary', `${label}: ${value}█`)
        : ` ${label}: ${value}`;
      const row = lines.length;
      lines.push(` ${pointer} ${field}`);
      regions.push({ start: row, end: lines.length, index: i });
    }
    this.mouse.setRegions(regions);
    lines.push('');
    if (this.errorMsg.length > 0) {
      lines.push(currentTheme.fg('error', ` ${this.errorMsg}`));
    }
    lines.push(currentTheme.fg('textMuted', t('tui.codingPlan.navHint')));
    lines.push(currentTheme.fg('primary', '─'.repeat(width)));
    return lines.map((line) => line.slice(0, width));
  }
}

function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    protocol: t('tui.codingPlan.fieldProtocol'),
    stream: t('tui.codingPlan.fieldStream'),
    temperature: t('tui.codingPlan.fieldTemperature'),
    maxTokens: t('tui.codingPlan.fieldMaxTokens'),
    enableThinking: t('tui.codingPlan.fieldEnableThinking'),
    searchDisable: t('tui.codingPlan.fieldSearchDisable'),
    showRefLabel: t('tui.codingPlan.fieldShowRefLabel'),
    loraId: t('tui.codingPlan.fieldLoraId'),
    reasoningEffort: t('tui.codingPlan.fieldReasoningEffort'),
  };
  return labels[key] ?? key;
}

interface FieldSchema {
  parse: (raw: string) => unknown;
  validate?: (value: unknown) => boolean;
}

const FIELD_SCHEMAS: Record<string, FieldSchema> = {
  protocol: { parse: (raw) => raw },
  stream: { parse: (raw) => raw === 'true' },
  temperature: {
    parse: (raw) => Number(raw),
    validate: (v) =>
      typeof v === 'number' && !Number.isNaN(v) && (v as number) >= 0 && (v as number) <= 2,
  },
  maxTokens: {
    parse: (raw) => Number(raw),
    validate: (v) =>
      typeof v === 'number' && !Number.isNaN(v) && Number.isInteger(v) && (v as number) >= 1,
  },
  enableThinking: { parse: (raw) => raw === 'true' },
  searchDisable: { parse: (raw) => raw === 'true' },
  showRefLabel: { parse: (raw) => raw === 'true' },
  loraId: { parse: (raw) => raw },
  reasoningEffort: { parse: (raw) => raw },
};
