import { describe, expect, test } from 'bun:test';

import { runEvaluator, scoreEvaluator } from '../src/benchmark/evaluators';

const ctx = (output: string) => ({ output, toolCalls: [], tokenUsage: { input: 0, output: 0 } });
const schema = (params: Record<string, unknown>) =>
  ({ name: 's', type: 'json-schema', params }) as Parameters<typeof runEvaluator>[0];

describe('json-schema evaluator', () => {
  // These two are the regression guards: both scored 1 under the parse-only
  // implementation, because it never looked at the schema.
  test('rejects a value missing a required field', () => {
    const evaluator = schema({
      schema: {
        type: 'object',
        required: ['MISSING_FIELD'],
        properties: { MISSING_FIELD: { type: 'string' } },
      },
    });
    expect(scoreEvaluator(evaluator, ctx('{"a":1}'))).toBe(0);
  });

  test('rejects a value of the wrong type', () => {
    expect(scoreEvaluator(schema({ schema: { type: 'array' } }), ctx('{"not":"array"}'))).toBe(0);
  });

  test('accepts a value that satisfies the schema', () => {
    const evaluator = schema({
      schema: { type: 'object', required: ['name'], properties: { name: { type: 'string' } } },
    });
    expect(scoreEvaluator(evaluator, ctx('{"name":"ok"}'))).toBe(1);
  });

  test('rejects unparseable output', () => {
    expect(scoreEvaluator(schema({ schema: { type: 'object' } }), ctx('not json'))).toBe(0);
  });

  test('rejects a schema keyword it does not implement rather than ignoring it', () => {
    for (const keyword of ['oneOf', 'patternProperties', '$ref', 'additionalProperties']) {
      const evaluator = schema({ schema: { type: 'object', [keyword]: {} } });
      expect(scoreEvaluator(evaluator, ctx('{}'))).toBe(0);
    }
  });

  test('rejects a case that declares no schema at all', () => {
    expect(scoreEvaluator(schema({}), ctx('{}'))).toBe(0);
  });

  test('rejects a schema nested more than one level deep', () => {
    const evaluator = schema({
      schema: {
        type: 'object',
        properties: {
          outer: { type: 'object', properties: { inner: { type: 'string' } } },
        },
      },
    });
    expect(scoreEvaluator(evaluator, ctx('{"outer":{"inner":"x"}}'))).toBe(0);
  });

  test('does not require properties that are absent but optional', () => {
    const evaluator = schema({
      schema: { type: 'object', properties: { optional: { type: 'string' } } },
    });
    expect(scoreEvaluator(evaluator, ctx('{}'))).toBe(1);
  });
});
