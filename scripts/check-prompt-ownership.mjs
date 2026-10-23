#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

const agents = readFileSync(join(ROOT, 'AGENTS.md'), 'utf8');
const develop = readFileSync(join(ROOT, 'DEVELOP.md'), 'utf8');
const contract = readFileSync(
  join(ROOT, 'packages/agent-core-v2/src/app/agentProfileCatalog/behaviorContract.ts'),
  'utf8',
);

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

if (failures.length > 0) {
  for (const failure of failures) console.error(`check-prompt-ownership: ${failure}`);
  process.exit(1);
}
console.log('check-prompt-ownership: OK');
