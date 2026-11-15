import { expect, it } from 'bun:test';

import { behaviorContractClause } from '#/app/agentProfileCatalog/behaviorContract';

it('requires existing project tooling before a new pipeline', () => {
  const clause = behaviorContractClause('tools_and_repository_context');
  expect(clause.full).toContain('existing tool or documented command');
  expect(clause.full).toContain('instead of reimplementing its steps');
});
