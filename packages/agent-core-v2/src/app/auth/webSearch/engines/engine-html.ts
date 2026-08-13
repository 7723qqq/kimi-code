/**
 * `auth` domain (cross-cutting) — minimal cheerio-compatible query layer over
 * linkedom for the ported search engines.
 *
 * The open-websearch engines parse with cheerio; kimi-code already depends on
 * linkedom, so this shim exposes the handful of cheerio calls the engines use
 * (`text` / `attr` / `find` / `each` / `first` / `length` / `map`) over
 * linkedom's `querySelectorAll` results.
 */

import { parseHTML } from 'linkedom';

export interface EngineElement {
  textContent: string | null;
  getAttribute(name: string): string | null;
  querySelectorAll(selector: string): readonly EngineElement[];
  querySelector(selector: string): EngineElement | null;
}

export interface EngineQueryResult {
  readonly length: number;
  text(): string;
  attr(name: string): string | null;
  find(selector: string): EngineQueryResult;
  first(): EngineQueryResult;
  each(fn: (index: number, element: EngineElement) => void): void;
  map<T>(fn: (index: number, element: EngineElement) => T): T[];
  toArray(): readonly EngineElement[];
}

function toResult(elements: readonly EngineElement[]): EngineQueryResult {
  return {
    get length() {
      return elements.length;
    },
    text(): string {
      return elements.map((el) => el.textContent ?? '').join('');
    },
    attr(name: string): string | null {
      return elements[0]?.getAttribute(name) ?? null;
    },
    find(selector: string): EngineQueryResult {
      const found: EngineElement[] = [];
      for (const el of elements) {
        found.push(...el.querySelectorAll(selector));
      }
      return toResult(found);
    },
    first(): EngineQueryResult {
      return toResult(elements.slice(0, 1));
    },
    each(fn: (index: number, element: EngineElement) => void): void {
      elements.forEach((el, index) =>{  fn(index, el); });
    },
    map<T>(fn: (index: number, element: EngineElement) => T): T[] {
      return elements.map((el, index) => fn(index, el));
    },
    toArray(): readonly EngineElement[] {
      return elements;
    },
  };
}

/** `load(html)` returns a query function like cheerio's top-level `$`. */
export function loadHtml(html: string): (selector: string) => EngineQueryResult {
  const { document } = parseHTML(html) as unknown as {
    document: { querySelectorAll(selector: string): readonly EngineElement[] };
  };
  return (selector: string) => toResult(document.querySelectorAll(selector));
}

/** Convenience: `$(html).find(selector)` chain for one-shot queries. */
export function queryHtml(html: string, selector: string): EngineQueryResult {
  return loadHtml(html)(selector);
}
