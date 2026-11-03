import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * @typedef {{name?: string, scripts?: Record<string, string>, workspaces?: {packages?: string[]}}} Manifest
 * @typedef {{dir: string, name: string, path: string, script: string}} TestProject
 */

/** @param {string} dir @returns {Manifest} */
function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
}

/** @param {string} root @param {string} script @returns {TestProject[]} */
export function listTestProjects(root, script) {
  const rootManifest = readManifest(root);
  const included = new Set();
  const excluded = new Set();

  for (const rawPattern of rootManifest.workspaces?.packages ?? []) {
    const negated = rawPattern.startsWith('!');
    const pattern = (negated ? rawPattern.slice(1) : rawPattern).replace(/^\.\//, '');
    const matches = [];
    if (pattern.endsWith('/*')) {
      const parent = pattern.slice(0, -2);
      const parentDir = join(root, parent);
      if (!existsSync(parentDir)) continue;
      for (const entry of readdirSync(parentDir, { withFileTypes: true })) {
        if (entry.isDirectory()) matches.push(`${parent}/${entry.name}`);
      }
    } else {
      matches.push(pattern);
    }
    for (const match of matches) {
      if (negated) excluded.add(match);
      else included.add(match);
    }
  }

  const projects = [];
  for (const path of included) {
    if (excluded.has(path)) continue;
    const dir = join(root, path);
    if (!existsSync(join(dir, 'package.json'))) continue;
    const manifest = readManifest(dir);
    if (!manifest.scripts?.[script]) continue;
    projects.push({ dir, name: manifest.name ?? path, path, script });
  }

  if (script === 'test' && rootManifest.scripts?.['test:scripts']) {
    projects.push({
      dir: root,
      name: '@moonshot-ai/repo-scripts',
      path: 'scripts',
      script: 'test:scripts',
    });
  }

  return projects;
}
