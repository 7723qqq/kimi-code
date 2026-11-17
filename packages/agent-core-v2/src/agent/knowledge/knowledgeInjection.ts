import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentReminderService } from '#/features/reminder/reminderService';

import { IAgentKnowledgeService, type KnowledgeSearchResult } from './knowledge';

const MAX_INJECTION_TOKENS = 800;
const MAX_ENTRIES = 5;

const PATH_EXTENSIONS = ['ts', 'js', 'rs', 'vue', 'tsx', 'jsx', 'json', 'md'];

function isWordChar(code: number | undefined): boolean {
  if (code === undefined) return false;
  return (
    (code >= 48 && code <= 57) ||
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    code === 95
  );
}

function isPathChar(code: number | undefined): boolean {
  return isWordChar(code) || code === 46 || code === 47 || code === 92 || code === 45;
}

function matchPathToken(text: string, start: number, runEnd: number): string | undefined {
  let end = runEnd;
  while (end > start && !isWordChar(text.codePointAt(end - 1))) end -= 1;
  for (const extension of PATH_EXTENSIONS) {
    const dot = end - extension.length - 1;
    if (dot > start && text.codePointAt(dot) === 46 && text.startsWith(extension, dot + 1)) {
      return text.slice(start, end);
    }
  }
  return undefined;
}

function findPathToken(text: string): string | undefined {
  let start = 0;
  for (let index = 0; index <= text.length; index += 1) {
    if (index < text.length && isPathChar(text.codePointAt(index))) continue;
    if (index > start) {
      const token = matchPathToken(text, start, index);
      if (token !== undefined) return token;
    }
    start = index + 1;
  }
  return undefined;
}

export class KnowledgeInjection extends Disposable {
  constructor(
    @IAgentKnowledgeService private readonly knowledge: IAgentKnowledgeService,
    @IAgentReminderService private readonly reminders: IAgentReminderService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
  ) {
    super();
    this._register(
      this.reminders.register('knowledge', ({ isNewTurn }) =>
        isNewTurn ? this.getInjection() : undefined,
      ),
    );
  }

  private getInjection(): string | undefined {
    const signals = this.extractSignals();
    if (!signals.query && !signals.scopePath) return undefined;

    const results = this.knowledge.search(
      signals.query,
      signals.scopePath,
      signals.tags,
      MAX_ENTRIES,
    );

    if (results.length === 0) return undefined;
    return this.formatInjection(results);
  }

  private extractSignals(): { query: string; scopePath?: string; tags: string[] } {
    const history = this.contextMemory.get();
    const tags: string[] = [];

    let lastUserText = '';
    for (let i = history.length - 1; i >= 0; i--) {
      const msg = history[i];
      if (msg?.role === 'user' && msg.content) {
        for (const part of msg.content) {
          if ('text' in part && part.text) {
            lastUserText = part.text;
            break;
          }
        }
        if (lastUserText) break;
      }
    }

    const words = lastUserText
      .slice(0, 200)
      .replaceAll(/[`"'()[\]{}]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2);
    const query = words.slice(0, 8).join(' ');

    const scopePath = findPathToken(lastUserText);

    if (lastUserText.includes('.ts') || lastUserText.includes('typescript'))
      tags.push('typescript');
    if (lastUserText.includes('.rs') || lastUserText.includes('rust')) tags.push('rust');
    if (lastUserText.includes('test')) tags.push('testing');
    if (lastUserText.includes('import')) tags.push('import');

    return { query, scopePath, tags: [...new Set(tags)] };
  }

  private formatInjection(results: KnowledgeSearchResult[]): string {
    const lines: string[] = ['[Knowledge Base — Relevant Standards]', ''];
    let tokensUsed = 10;

    for (let i = 0; i < results.length; i++) {
      const r = results[i]!;
      const firstLine = r.entry.content.split('\n')[0] ?? '';
      const line = `${i + 1}. [${r.entry.category}] ${r.entry.title}\n   ${firstLine}`;
      const lineTokens = Math.ceil(line.length / 4);
      if (tokensUsed + lineTokens > MAX_INJECTION_TOKENS) break;
      lines.push(line, '');
      tokensUsed += lineTokens;
    }

    return lines.join('\n');
  }
}
