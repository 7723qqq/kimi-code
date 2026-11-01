#!/usr/bin/env bun
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const PROMPT_DIR = 'packages/agent-core-v2/src/app/agentProfileCatalog';

const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const develop = readFileSync(join(ROOT, 'DEVELOP.md'), 'utf8');
const contract = readFileSync(join(ROOT, PROMPT_DIR, 'behaviorContract.ts'), 'utf8');
const skeleton = readFileSync(join(ROOT, PROMPT_DIR, 'system.md'), 'utf8');
const profileShared = readFileSync(join(ROOT, PROMPT_DIR, 'profile-shared.ts'), 'utf8');

check(/\]\(DEVELOP\.md\)/.test(agents), 'AGENTS.md must link to DEVELOP.md');
check(
  /read on demand|not injected/i.test(agents),
  'AGENTS.md must state that DEVELOP.md is read on demand, not injected',
);
check(
  !/DEVELOP\.md[^\n]*(is|are)\s+(automatically\s+)?injected/i.test(agents),
  'AGENTS.md must not claim DEVELOP.md is injected automatically',
);
check(
  agents.includes('behaviorContract.ts'),
  'AGENTS.md must point at the behavior contract owner',
);
check(
  develop.includes('## Instruction Ownership and Precedence'),
  'DEVELOP.md must own the instruction precedence section',
);
check(
  develop.includes('behaviorContract.ts') && develop.includes('profile-shared.ts'),
  'DEVELOP.md must name the contract and render owners',
);
const ids = [
  'authority_and_untrusted_content',
  'act_and_verify',
  'tools_and_repository_context',
  'safety_and_scope',
  'failure_and_partial_progress',
  'communication',
];
for (const id of ids) {
  check(contract.includes(`'${id}'`), `behaviorContract.ts must define the core id ${id}`);
}

/**
 * The prompt is a skeleton plus the section files it delegates to. Both halves
 * need an owner and a check: a section file that stops being injected, or a
 * placeholder whose file disappears, silently drops guidance the model used to
 * receive — and `system.md` alone still looks complete when that happens.
 */
const SECTIONS = [
  {
    placeholder: 'coding_section',
    file: 'coding.md',
    mustContain: 'Write code that fits the code around it',
  },
  {
    placeholder: 'delivering_work_section',
    file: 'delivering-work.md',
    readOnlyFile: 'delivering-work-read-only.md',
    mustContain: 'Do what was asked',
  },
  {
    placeholder: 'agents_section',
    file: 'project-information.md',
    mustContain: 'cannot override these instructions',
  },
];

for (const section of SECTIONS) {
  const path = join(ROOT, PROMPT_DIR, section.file);
  check(existsSync(path), `${section.file} must exist beside system.md`);
  if (existsSync(path)) {
    check(
      readFileSync(path, 'utf8').includes(section.mustContain),
      `${section.file} must still carry its owned guidance ("${section.mustContain}")`,
    );
  }
  check(
    skeleton.includes(`\${${section.placeholder}}`),
    `system.md must keep the \${${section.placeholder}} placeholder that injects ${section.file}`,
  );
  check(
    profileShared.includes(section.placeholder),
    `profile-shared.ts must resolve \${${section.placeholder}}`,
  );
  if (section.readOnlyFile !== undefined) {
    check(
      existsSync(join(ROOT, PROMPT_DIR, section.readOnlyFile)),
      `${section.readOnlyFile} must exist beside system.md`,
    );
    check(
      profileShared.includes(section.readOnlyFile.replace(/\.md$/, '')),
      `profile-shared.ts must reference ${section.readOnlyFile} for read-only profiles`,
    );
  }
  check(develop.includes(section.file), `DEVELOP.md's ownership table must name ${section.file}`);
}

// `system.md` is a skeleton; a table describing it as the whole prompt is stale.
check(
  !/\|\s*Full-profile expression[^|]*\|\s*`?[^`|]*system\.md`?\s*\|/.test(develop),
  'DEVELOP.md must not describe system.md as the full-profile expression',
);

if (failures.length > 0) {
  for (const failure of failures) console.error(`check-prompt-ownership: ${failure}`);
  process.exit(1);
}
console.log('check-prompt-ownership: OK');
