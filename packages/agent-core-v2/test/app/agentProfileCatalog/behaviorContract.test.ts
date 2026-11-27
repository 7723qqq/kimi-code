import { expect, it } from 'bun:test';

import { behaviorContractClause } from '#/app/agentProfileCatalog/behaviorContract';

it('requires existing project tooling before a new pipeline', () => {
  const clause = behaviorContractClause('tools_and_repository_context');
  expect(clause.full).toContain('existing tool or documented command');
  expect(clause.full).toContain('instead of reimplementing its steps');
});

it('forbids guessing code or reasoning backward from an assumed target', () => {
  const clause = behaviorContractClause('tools_and_repository_context');
  expect(clause.full).toContain('Never guess any single line of code');
  expect(clause.full).toContain('never draw the target before shooting the arrow');
});
