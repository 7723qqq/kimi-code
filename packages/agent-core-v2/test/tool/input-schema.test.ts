import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  compileToolArgsValidator,
  validateToolArgs,
} from '#/tool/args-validator';
import { toInputJsonSchema } from '#/tool/input-schema';

function collectRequired(schema: unknown, acc: string[] = []): string[] {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRequired(item, acc);
    return acc;
  }
  if (typeof schema !== 'object' || schema === null) return acc;
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'required' && Array.isArray(value)) {
      for (const name of value) if (typeof name === 'string') acc.push(name);
    } else {
      collectRequired(value, acc);
    }
  }
  return acc;
}

/**
 * `toInputJsonSchema` returns a plain `Record<string, unknown>` JSON Schema
 * node; the `properties` member is only reachable through index access and its
 * children need casting before nested reads.
 */
function propsOf(schema: unknown): Record<string, unknown> | undefined {
  const props = (schema as Record<string, unknown> | undefined)?.['properties'];
  return typeof props === 'object' && props !== null
    ? (props as Record<string, unknown>)
    : undefined;
}

function propOf(schema: unknown, name: string): Record<string, unknown> | undefined {
  const value = propsOf(schema)?.[name];
  return typeof value === 'object' && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

describe('tool input JSON Schema', () => {
  const inputSchema = z
    .object({
      mode: z.enum(['read', 'write']).default('read'),
      items: z
        .array(
          z
            .object({
              label: z.string(),
              description: z.string().default(''),
            })
            .strict(),
        )
        .default([]),
    })
    .strict();

  it('keeps defaulted fields out of `required`', () => {
    const schema = toInputJsonSchema(inputSchema);
    const required = collectRequired(schema);

    expect(required).not.toContain('mode');
    expect(required).not.toContain('items');
    expect(required).not.toContain('description');
    expect(required).toContain('label');
  });

  it('accepts an empty object through runtime argument validation', () => {
    const schema = toInputJsonSchema(inputSchema);
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, {})).toBeNull();
  });

  it('rejects an unknown top-level argument through runtime validation', () => {
    const schema = toInputJsonSchema(inputSchema);
    const validator = compileToolArgsValidator(schema);

    expect(validateToolArgs(validator, { bogus: true })).not.toBeNull();
  });

  it('rejects an unknown nested argument through runtime validation', () => {
    const schema = toInputJsonSchema(inputSchema);
    const validator = compileToolArgsValidator(schema);

    expect(
      validateToolArgs(validator, {
        items: [{ label: 'A', bogus: true }],
      }),
    ).not.toBeNull();
  });

  it('handles union types correctly', () => {
    const unionSchema = z.union([z.string(), z.number()]);
    const jsonSchema = toInputJsonSchema(unionSchema);
    expect(jsonSchema['anyOf']).toBeDefined();
    expect(jsonSchema['anyOf']).toHaveLength(2);
  });

  it('handles optional fields correctly', () => {
    const optionalSchema = z.object({
      name: z.string().optional(),
      count: z.number().optional(),
    });
    const jsonSchema = toInputJsonSchema(optionalSchema);
    const required = collectRequired(jsonSchema);
    expect(required).not.toContain('name');
    expect(required).not.toContain('count');
  });

  it('handles nullable fields correctly', () => {
    const nullableSchema = z.object({
      value: z.string().nullable(),
    });
    const jsonSchema = toInputJsonSchema(nullableSchema);
    const valueProp = propOf(jsonSchema, 'value');
    expect(valueProp).toBeDefined();
    expect(valueProp?.['anyOf']).toBeDefined();
  });

  it('handles literal types', () => {
    const literalSchema = z.object({
      kind: z.literal('specific'),
    });
    const jsonSchema = toInputJsonSchema(literalSchema);
    expect(propOf(jsonSchema, 'kind')?.['const']).toBe('specific');
  });

  it('handles discriminated unions', () => {
    const base = z.discriminatedUnion('type', [
      z.object({ type: z.literal('a'), value: z.string() }),
      z.object({ type: z.literal('b'), count: z.number() }),
    ]);
    const jsonSchema = toInputJsonSchema(base);
    expect(jsonSchema['oneOf'] ?? jsonSchema['anyOf'] ?? jsonSchema['discriminator']).toBeDefined();
  });

  it('handles enum schemas', () => {
    const enumSchema = z.enum(['red', 'green', 'blue']);
    const jsonSchema = toInputJsonSchema(enumSchema);
    expect(jsonSchema['enum']).toEqual(['red', 'green', 'blue']);
  });

  it('handles string, number, boolean, and array primitives', () => {
    const primitiveSchema = z.object({
      s: z.string(),
      n: z.number(),
      b: z.boolean(),
      arr: z.array(z.string()),
    });
    const jsonSchema = toInputJsonSchema(primitiveSchema);
    expect(propOf(jsonSchema, 's')?.['type']).toBe('string');
    expect(propOf(jsonSchema, 'n')?.['type']).toBe('number');
    expect(propOf(jsonSchema, 'b')?.['type']).toBe('boolean');
    expect(propOf(jsonSchema, 'arr')?.['type']).toBe('array');
    expect(
      (propOf(jsonSchema, 'arr')?.['items'] as Record<string, unknown> | undefined)?.['type'],
    ).toBe('string');
  });

  it('handles default values in the JSON schema output', () => {
    const schemaWithDefaults = z.object({
      greeting: z.string().default('hello'),
      retries: z.number().default(3),
    });
    const jsonSchema = toInputJsonSchema(schemaWithDefaults);
    expect(propOf(jsonSchema, 'greeting')?.['default']).toBe('hello');
    expect(propOf(jsonSchema, 'retries')?.['default']).toBe(3);
  });

  it('handles string length constraints', () => {
    const constrained = z.object({
      short: z.string().min(1).max(10),
    });
    const jsonSchema = toInputJsonSchema(constrained);
    expect(propOf(jsonSchema, 'short')?.['minLength']).toBe(1);
    expect(propOf(jsonSchema, 'short')?.['maxLength']).toBe(10);
  });

  it('handles number range constraints', () => {
    const ranged = z.object({
      score: z.number().min(0).max(100),
    });
    const jsonSchema = toInputJsonSchema(ranged);
    expect(propOf(jsonSchema, 'score')?.['minimum']).toBe(0);
    expect(propOf(jsonSchema, 'score')?.['maximum']).toBe(100);
  });

  it('handles array length constraints', () => {
    const arrayConstraints = z.object({
      tags: z.array(z.string()).min(1).max(5),
    });
    const jsonSchema = toInputJsonSchema(arrayConstraints);
    expect(propOf(jsonSchema, 'tags')?.['minItems']).toBe(1);
    expect(propOf(jsonSchema, 'tags')?.['maxItems']).toBe(5);
  });

  it('handles regex patterns', () => {
    const patternSchema = z.object({
      email: z.string().regex(/^[a-z]+@[a-z]+\.[a-z]+$/),
    });
    const jsonSchema = toInputJsonSchema(patternSchema);
    expect(propOf(jsonSchema, 'email')?.['pattern']).toBeDefined();
  });

  it('handles transforms by preserving the underlying schema type', () => {
    const transformSchema = z.object({
      port: z.coerce.number(),
    });
    const jsonSchema = toInputJsonSchema(transformSchema);
    // Coerce.number() still produces a number schema
    expect(propOf(jsonSchema, 'port')?.['type']).toBe('number');
  });

  it('handles optional fields with defaults as not required', () => {
    const optionalWithDefault = z.object({
      timeout: z.number().default(30),
      host: z.string().optional(),
    });
    const jsonSchema = toInputJsonSchema(optionalWithDefault);
    const required = collectRequired(jsonSchema);
    expect(required).not.toContain('timeout');
    expect(required).not.toContain('host');
  });
});
