import { describe, expect, it } from 'bun:test';

import { compactMcpInputSchema } from '#/mcpCore/schema-compaction';

describe('compactMcpInputSchema', () => {
  it('shortens parameter descriptions and drops prose-only keys', () => {
    const schema = {
      type: 'object',
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          title: 'Query',
          description: 'Query the thing. Extra parameter detail.',
          examples: ['moon'],
        },
        mode: {
          type: 'string',
          enum: ['fast', 'slow'],
          description: 'Execution mode. Choose carefully.',
        },
      },
      additionalProperties: false,
    };

    const compacted = compactMcpInputSchema(schema);
    const properties = compacted['properties'] as Record<string, Record<string, unknown>>;
    const query = properties['query']!;
    const mode = properties['mode']!;

    expect(query['description']).toBe('Query the thing.');
    expect(query['title']).toBeUndefined();
    expect(query['examples']).toBeUndefined();
    expect(query['type']).toBe('string');
    expect(mode['description']).toBe('Execution mode.');
    expect(mode['enum']).toEqual(['fast', 'slow']);
    expect(compacted['required']).toEqual(['query']);
    expect(compacted['additionalProperties']).toBe(false);
  });

  it('does not mutate the source schema', () => {
    const schema = {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'First. Second.' },
      },
    };

    compactMcpInputSchema(schema);

    const original = schema.properties.query;
    expect(original.description).toBe('First. Second.');
  });

  it('compacts nested array item descriptions', () => {
    const compacted = compactMcpInputSchema({
      type: 'array',
      items: {
        type: 'object',
        properties: {
          value: { type: 'string', description: 'Value first. Value second.' },
        },
      },
    });

    const items = compacted['items'] as Record<string, unknown>;
    const properties = items['properties'] as Record<string, Record<string, unknown>>;
    expect(properties['value']?.['description']).toBe('Value first.');
  });

  it('truncates an overlong first sentence with an ellipsis', () => {
    const description = `${'long description '.repeat(20)}`;
    const compacted = compactMcpInputSchema({
      type: 'object',
      properties: { value: { type: 'string', description } },
    });

    const properties = compacted['properties'] as Record<string, Record<string, unknown>>;
    const compactedDescription = properties['value']?.['description'];
    expect(typeof compactedDescription).toBe('string');
    expect((compactedDescription as string).endsWith('…')).toBe(true);
    expect((compactedDescription as string).length).toBeLessThanOrEqual(161);
  });
});
