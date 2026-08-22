import { describe, expect, it } from 'vitest';

import { migrateV1_5ToV1_6 } from '#/wire/migration/v1.6';

import { runMigration } from './utils';

describe('1.5 to 1.6 tool.call display migration', () => {
  it('passes records through unchanged', () => {
    expect(
      runMigration(migrateV1_5ToV1_6, [
        {
          type: 'metadata',
          protocol_version: '1.5',
          created_at: 1,
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            stepUuid: 's1',
            toolCallId: 'c1',
            name: 'Edit',
            args: { path: 'a.txt' },
          },
        },
        {
          type: 'context.append_loop_event',
          event: {
            type: 'tool.call',
            stepUuid: 's1',
            toolCallId: 'c2',
            name: 'TodoList',
            args: {},
            display: { kind: 'todo_list', items: [{ title: 'Ship', status: 'pending' }] },
          },
        },
      ]),
    ).toMatchInlineSnapshot(`
      [wire] metadata                    { "protocol_version": "1.6", "created_at": "<time>" }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "stepUuid": "s1", "toolCallId": "c1", "name": "Edit", "args": { "path": "a.txt" } } }
      [wire] context.append_loop_event   { "event": { "type": "tool.call", "stepUuid": "s1", "toolCallId": "c2", "name": "TodoList", "args": {}, "display": { "kind": "todo_list", "items": [ { "title": "Ship", "status": "pending" } ] } } }
    `);
  });
});
