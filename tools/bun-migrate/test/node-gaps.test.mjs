/**
 * The migration risk that runs the other way: code that works on Node but must
 * not be moved to Bun unchanged, because Bun's `node:` layer lacks the member.
 *
 * Every assertion here compares against the running runtime rather than a
 * changelog, so a Bun that closes a gap makes the corresponding test report it
 * instead of silently passing.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { createJournal } from '../src/journal.mjs';
import { applyNodeGapLayer } from '../src/layers/node-gaps.mjs';
import {
  activeGaps,
  BUN_ONLY_APIS,
  closedGaps,
  findMissingUsages,
  KNOWN_NODE_GAPS,
  memberExists,
} from '../src/node-gaps.mjs';
import { loadProject } from '../src/project.mjs';

const nodeAvailable = (() => Bun.spawnSync(['node', '--version']).exitCode === 0)();

function runUnderNode(script) {
  const directory = mkdtempSync(join(tmpdir(), 'gap-'));
  const file = join(directory, 'probe.cjs');
  try {
    writeFileSync(file, script, 'utf8');
    const result = Bun.spawnSync(['node', file], { cwd: directory });
    return result.stdout.toString().trim();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

describe('gap table is live, not a snapshot', () => {
  it('every recorded gap is either open or explicitly closed on this Bun', () => {
    const open = activeGaps();
    const closed = closedGaps();
    expect(open.length + closed.length).toBe(KNOWN_NODE_GAPS.length);
    for (const gap of KNOWN_NODE_GAPS) {
      expect(typeof gap.workaround).toBe('string');
      expect(gap.workaround.length).toBeGreaterThan(10);
    }
  });

  it('the probe reflects reality for a member that certainly exists', () => {
    expect(memberExists('node:fs', 'readFileSync')).toBe(true);
    expect(memberExists('node:fs', 'definitelyNotARealExport')).toBe(false);
  });

  it('a module that fails to load reports as missing rather than throwing', () => {
    expect(memberExists('node:does-not-exist', 'anything')).toBe(false);
  });
});

describe('the gaps match Node, verified by running both', () => {
  const CASES = [
    ['node:module', 'registerHooks'],
    ['node:module', 'stripTypeScriptTypes'],
    ['node:module', 'findPackageJSON'],
    ['node:util', 'transferableAbortController'],
  ];

  for (const [module, member] of CASES) {
    it(`${module}#${member} exists on Node`, () => {
      if (!nodeAvailable) throw new Error('node must be on PATH: this case asserts what Node provides, so skipping it would report a pass that proves nothing');
      const output = runUnderNode(
        `try { const m = require('${module}'); process.stdout.write(m['${member}'] === undefined ? 'MISSING' : 'PRESENT'); } catch (e) { process.stdout.write('THREW'); }`,
      );
      expect(output).toBe('PRESENT');
    });

    it(`${module}#${member} is recorded as a gap on this Bun`, () => {
      if (!nodeAvailable) throw new Error('node must be on PATH: this case asserts what Node provides, so skipping it would report a pass that proves nothing');
      if (memberExists(module, member)) {
        process.stdout.write(`NOTE: this Bun now provides ${module}#${member}; the gap entry can be removed\n`);
        return;
      }
      const recorded = KNOWN_NODE_GAPS.some((gap) => gap.module === module && gap.member === member);
      expect(recorded).toBe(true);
    });
  }

  it('node:crypto.hash and util.parseEnv exist on both sides', () => {
    if (!nodeAvailable) throw new Error('node must be on PATH: this case asserts what Node provides, so skipping it would report a pass that proves nothing');
    for (const [module, member] of [['node:crypto', 'hash'], ['node:util', 'parseEnv'], ['node:path', 'matchesGlob']]) {
      const output = runUnderNode(
        `process.stdout.write(require('${module}')['${member}'] === undefined ? 'MISSING' : 'PRESENT');`,
      );
      expect(`${module}#${member} node=${output}`).toBe(`${module}#${member} node=PRESENT`);
      expect(`${module}#${member} bun=${memberExists(module, member)}`).toBe(`${module}#${member} bun=true`);
    }
  });
});

describe('usage detection is narrow enough to trust', () => {
  const gaps = [{ module: 'node:module', member: 'registerHooks' }];

  it('finds a named import', () => {
    const hits = findMissingUsages("import { registerHooks } from 'node:module';\n", gaps);
    expect(hits.length).toBe(1);
  });

  it('finds a destructured require', () => {
    const hits = findMissingUsages("const { registerHooks } = require('node:module');\n", gaps);
    expect(hits.length).toBe(1);
  });

  it('finds a bare call even without an import in the same file', () => {
    const hits = findMissingUsages('registerHooks({ resolve() {} });\n', gaps);
    expect(hits.length).toBe(1);
  });

  it('ignores a mention inside a string', () => {
    const hits = findMissingUsages("const note = 'registerHooks is not available';\n", gaps);
    expect(hits.length).toBe(0);
  });

  it('ignores a longer identifier that merely contains the name', () => {
    const hits = findMissingUsages('myRegisterHooksThing();\n', gaps);
    expect(hits.length).toBe(0);
  });
});

describe('the layer reports without editing', () => {
  function project(files) {
    const root = mkdtempSync(join(tmpdir(), 'gapprj-'));
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, content, 'utf8');
    }
    return root;
  }

  it('skips the file with a workaround, and changes nothing', () => {
    const root = project({
      'package.json': '{"name":"g","version":"1.0.0"}\n',
      'src/a.ts': "import { registerHooks } from 'node:module';\nexport const a = registerHooks({});\n",
    });
    try {
      const loaded = loadProject(root);
      const journal = createJournal(['source']);
      applyNodeGapLayer(loaded, journal);
      expect(journal.changes.length).toBe(0);
      const skipped = journal.layers()[0].skipped;
      expect(skipped.length).toBe(1);
      expect(skipped[0].reason).toContain('registerHooks');
      expect(skipped[0].reason).toContain('fails at run time');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('says nothing about a project that does not touch the gap', () => {
    const root = project({
      'package.json': '{"name":"g","version":"1.0.0"}\n',
      'src/a.ts': "import { readFileSync } from 'node:fs';\nexport const a = () => readFileSync('x', 'utf8');\n",
    });
    try {
      const loaded = loadProject(root);
      const journal = createJournal(['source']);
      applyNodeGapLayer(loaded, journal);
      expect(journal.layers()[0].skipped.length).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  /**
   * `--no-source` and `--only config` turn off the rewrites. The gap warning is
   * a report about code that will throw on the first run under Bun, so it has
   * to survive both: measured before this was pinned, `--only config,packages`
   * silenced the warning along with the rewrites, and the run ended `exit 0`
   * with the crash one `bun` invocation away.
   */
  it('reports gaps even when the source layer is not requested', () => {
    const root = project({
      'package.json': '{"name":"g","version":"1.0.0"}\n',
      'src/a.ts': "import { registerHooks } from 'node:module';\nexport const a = registerHooks({});\n",
    });
    try {
      const loaded = loadProject(root);
      const journal = createJournal(['config', 'packages']);
      applyNodeGapLayer(loaded, journal);
      const layers = journal.layers();
      const sourceLayer = layers.find((layer) => layer.name === 'source');
      expect(sourceLayer).toBeDefined();
      expect(sourceLayer.changes.length).toBe(0);
      expect(sourceLayer.skipped.length).toBe(1);
      expect(sourceLayer.skipped[0].reason).toContain('registerHooks');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('Bun-only APIs are recorded so shared code knows the constraint', () => {
  it('lists the APIs with no Node counterpart', () => {
    for (const name of ['Bun.file', 'Bun.write', 'Bun.SQL', 'Bun.serve', 'Bun.YAML', 'Bun.FFI']) {
      expect(BUN_ONLY_APIS).toContain(name);
    }
  });

  it('every listed API actually exists on this Bun', () => {
    for (const path of BUN_ONLY_APIS) {
      const parts = path.split('.');
      let value = globalThis;
      for (const part of parts) value = value?.[part];
      expect(`${path} exists=${value !== undefined}`).toBe(`${path} exists=true`);
    }
  });
});
