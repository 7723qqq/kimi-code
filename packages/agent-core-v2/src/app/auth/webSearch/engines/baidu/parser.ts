/**
 * `auth` domain (cross-cutting) — Baidu SERP parser, ported from the
 * open-websearch project (`engines/baidu/baidu.js`). Extracts organic
 * results from Baidu result pages through the linkedom shim (`loadHtml`):
 * iterates the direct children of `#content_left`, requires an `h3` title
 * block and an `http(s)` result link per child, and reads the snippet from
 * the `.c-font-normal.c-color-text` `aria-label` (falling back to the
 * `.cos-row` text) plus the source from `.cosc-source`. The shim's query
 * layer omits cheerio's `children`, so the child list is read from the
 * underlying DOM element.
 */

import { loadHtml, type EngineElement } from '../engine-html';

export interface BaiduSearchResult {
  title: string;
  url: string;
  description: string;
  source: string;
  engine: 'baidu';
}

/** Concatenated text of every selector match, mirroring cheerio's `.text()`. */
function textOfAll(element: EngineElement, selector: string): string {
  return element
    .querySelectorAll(selector)
    .map((el) => el.textContent ?? '')
    .join('');
}

export function parseBaiduSearchResults(html: string): BaiduSearchResult[] {
  const $ = loadHtml(html);
  const results: BaiduSearchResult[] = [];
  for (const contentBlock of $('#content_left').toArray()) {
    const children = Array.from(
      (contentBlock as EngineElement & { children?: ArrayLike<EngineElement> }).children ?? [],
    );
    for (const element of children) {
      const titleElement = element.querySelector('h3');
      const linkElement = element.querySelector('a');
      if (titleElement === null || linkElement === null) {
        continue;
      }
      const url = linkElement.getAttribute('href');
      if (url === null || !url.startsWith('http')) {
        continue;
      }
      const snippetBaidu = element.querySelector('.c-font-normal.c-color-text');
      const snippetElement = element.querySelector('.cos-row');
      results.push({
        title: titleElement.textContent ?? '',
        url,
        description:
          snippetBaidu?.getAttribute('aria-label') ?? (snippetElement?.textContent ?? '').trim(),
        source: textOfAll(element, '.cosc-source').trim(),
        engine: 'baidu',
      });
    }
  }
  return results;
}
