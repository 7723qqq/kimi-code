import { TodoUpdated } from '@moonshot-ai/agent-core-v2';
import { describe, expect, it } from 'vitest';

import { translateDomainEvent } from '#/v2/event-mapper';

describe('todo.updated crosses the v2 → SDK event edge', () => {
  it('is not dropped by the translation filter', () => {
    const event = new TodoUpdated({
      agentId: 'main',
      todos: [
        { id: 'M1', parentId: null, kind: 'milestone', title: 'phase', status: 'pending' },
        {
          id: 'M1.1',
          parentId: 'M1',
          kind: 'task',
          title: 'leaf',
          status: 'in_progress',
          progress: 55,
          description: 'still going',
        },
      ],
      rev: 7,
    });

    const translated = translateDomainEvent(event, 's1', 'main');

    expect(translated).toBeDefined();
    expect(translated).toMatchObject({
      type: 'todo.updated',
      sessionId: 's1',
      agentId: 'main',
      rev: 7,
      todos: [
        { id: 'M1', parentId: null, kind: 'milestone', title: 'phase', status: 'pending' },
        {
          id: 'M1.1',
          parentId: 'M1',
          kind: 'task',
          title: 'leaf',
          status: 'in_progress',
          progress: 55,
          description: 'still going',
        },
      ],
    });
  });

  it('carries the writing agent id through, not the session default', () => {
    const event = new TodoUpdated({
      agentId: 'agent-1',
      todos: [{ id: 'T1', parentId: null, kind: 'task', title: 'sub', status: 'done' }],
      rev: 1,
    });

    const translated = translateDomainEvent(event, 's1', 'agent-1');

    expect(translated).toMatchObject({ type: 'todo.updated', agentId: 'agent-1', sessionId: 's1' });
  });

  it('keeps an empty list distinguishable from a missing payload', () => {
    const event = new TodoUpdated({ agentId: 'main', todos: [], rev: 2 });

    const translated = translateDomainEvent(event, 's1', 'main');

    expect(translated).toMatchObject({ type: 'todo.updated', todos: [], rev: 2 });
  });
});
