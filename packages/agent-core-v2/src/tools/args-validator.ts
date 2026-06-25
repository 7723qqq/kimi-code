/**
 * `tools` support module — validates tool-call arguments against the JSON
 * Schema subset used by built-in and MCP tool definitions.
 */

export type JsonType = null | number | string | boolean | JsonArray | JsonObject;

/** @internal */
export interface JsonArray extends Array<JsonType> {}

/** @internal */
export interface JsonObject extends Record<string, JsonType> {}

export interface ToolArgsValidator {
  readonly schema: Record<string, unknown>;
}

interface ValidationError {
  readonly keyword: string;
  readonly instancePath: string;
  readonly message: string;
  readonly params?: Record<string, unknown>;
}

function formatValidationError(error: ValidationError): string {
  if (
    error.keyword === 'required' &&
    error.params !== undefined &&
    'missingProperty' in error.params
  ) {
    return `must have required property '${String(error.params['missingProperty'])}'`;
  }

  if (
    error.keyword === 'additionalProperties' &&
    error.params !== undefined &&
    'additionalProperty' in error.params
  ) {
    return `must NOT have additional property '${String(error.params['additionalProperty'])}'`;
  }

  const path = error.instancePath ? `${error.instancePath} ` : '';
  return `${path}${error.message}`;
}

export function compileToolArgsValidator(schema: Record<string, unknown>): ToolArgsValidator {
  return { schema };
}

export function validateToolArgs(validator: ToolArgsValidator, args: JsonType): string | null {
  const errors: ValidationError[] = [];
  validateSchema(validator.schema, args, '', errors);
  if (errors.length === 0) {
    return null;
  }

  return errors.map((error) => formatValidationError(error)).join('; ');
}

function validateSchema(
  schema: Record<string, unknown>,
  value: unknown,
  instancePath: string,
  errors: ValidationError[],
): void {
  if (schema['const'] !== undefined && !deepEqual(value, schema['const'])) {
    errors.push({ keyword: 'const', instancePath, message: 'must be equal to constant' });
  }

  const enumValues = schema['enum'];
  if (Array.isArray(enumValues) && !enumValues.some((item) => deepEqual(item, value))) {
    errors.push({ keyword: 'enum', instancePath, message: 'must be equal to one of the allowed values' });
  }

  const type = schema['type'];
  if (type !== undefined && !matchesType(value, type)) {
    errors.push({ keyword: 'type', instancePath, message: `must be ${formatType(type)}` });
    return;
  }

  validateCombinators(schema, value, instancePath, errors);

  if (isPlainObject(value)) {
    validateObject(schema, value, instancePath, errors);
  }

  if (Array.isArray(value)) {
    validateArray(schema, value, instancePath, errors);
  }

  if (typeof value === 'string') {
    validateString(schema, value, instancePath, errors);
  }

  if (typeof value === 'number') {
    validateNumber(schema, value, instancePath, errors);
  }
}

function validateObject(
  schema: Record<string, unknown>,
  value: Record<string, unknown>,
  instancePath: string,
  errors: ValidationError[],
): void {
  const required = schema['required'];
  if (Array.isArray(required)) {
    for (const property of required) {
      if (typeof property === 'string' && !(property in value)) {
        errors.push({
          keyword: 'required',
          instancePath,
          message: `must have required property '${property}'`,
          params: { missingProperty: property },
        });
      }
    }
  }

  const properties = schema['properties'];
  if (isSchemaMap(properties)) {
    for (const [property, propertySchema] of Object.entries(properties)) {
      if (property in value) {
        validateSchema(propertySchema, value[property], `${instancePath}/${escapePath(property)}`, errors);
      }
    }
  }

  if (schema['additionalProperties'] === false && isSchemaMap(properties)) {
    for (const property of Object.keys(value)) {
      if (!(property in properties)) {
        errors.push({
          keyword: 'additionalProperties',
          instancePath,
          message: `must NOT have additional property '${property}'`,
          params: { additionalProperty: property },
        });
      }
    }
  }
}

function validateArray(
  schema: Record<string, unknown>,
  value: unknown[],
  instancePath: string,
  errors: ValidationError[],
): void {
  const minItems = schema['minItems'];
  if (typeof minItems === 'number' && value.length < minItems) {
    errors.push({ keyword: 'minItems', instancePath, message: `must NOT have fewer than ${minItems} items` });
  }

  const maxItems = schema['maxItems'];
  if (typeof maxItems === 'number' && value.length > maxItems) {
    errors.push({ keyword: 'maxItems', instancePath, message: `must NOT have more than ${maxItems} items` });
  }

  const items = schema['items'];
  if (isSchema(items)) {
    value.forEach((item, index) => {
      validateSchema(items, item, `${instancePath}/${index}`, errors);
    });
  } else if (Array.isArray(items)) {
    items.forEach((itemSchema, index) => {
      if (isSchema(itemSchema) && index < value.length) {
        validateSchema(itemSchema, value[index], `${instancePath}/${index}`, errors);
      }
    });
  }
}

function validateString(
  schema: Record<string, unknown>,
  value: string,
  instancePath: string,
  errors: ValidationError[],
): void {
  const minLength = schema['minLength'];
  if (typeof minLength === 'number' && value.length < minLength) {
    errors.push({ keyword: 'minLength', instancePath, message: `must NOT have fewer than ${minLength} characters` });
  }

  const maxLength = schema['maxLength'];
  if (typeof maxLength === 'number' && value.length > maxLength) {
    errors.push({ keyword: 'maxLength', instancePath, message: `must NOT have more than ${maxLength} characters` });
  }

  const pattern = schema['pattern'];
  if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
    errors.push({ keyword: 'pattern', instancePath, message: `must match pattern "${pattern}"` });
  }
}

function validateNumber(
  schema: Record<string, unknown>,
  value: number,
  instancePath: string,
  errors: ValidationError[],
): void {
  const minimum = schema['minimum'];
  if (typeof minimum === 'number' && value < minimum) {
    errors.push({ keyword: 'minimum', instancePath, message: `must be >= ${minimum}` });
  }

  const maximum = schema['maximum'];
  if (typeof maximum === 'number' && value > maximum) {
    errors.push({ keyword: 'maximum', instancePath, message: `must be <= ${maximum}` });
  }
}

function validateCombinators(
  schema: Record<string, unknown>,
  value: unknown,
  instancePath: string,
  errors: ValidationError[],
): void {
  const allOf = schema['allOf'];
  if (Array.isArray(allOf)) {
    for (const child of allOf) {
      if (isSchema(child)) validateSchema(child, value, instancePath, errors);
    }
  }

  const anyOf = schema['anyOf'];
  if (Array.isArray(anyOf) && !anyOf.some((child) => isSchema(child) && schemaMatches(child, value))) {
    errors.push({ keyword: 'anyOf', instancePath, message: 'must match at least one schema' });
  }

  const oneOf = schema['oneOf'];
  if (Array.isArray(oneOf)) {
    const matches = oneOf.filter((child) => isSchema(child) && schemaMatches(child, value)).length;
    if (matches !== 1) {
      errors.push({ keyword: 'oneOf', instancePath, message: 'must match exactly one schema' });
    }
  }
}

function schemaMatches(schema: Record<string, unknown>, value: unknown): boolean {
  const errors: ValidationError[] = [];
  validateSchema(schema, value, '', errors);
  return errors.length === 0;
}

function matchesType(value: unknown, type: unknown): boolean {
  if (Array.isArray(type)) return type.some((item) => matchesType(value, item));
  switch (type) {
    case 'null':
      return value === null;
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'string':
      return typeof value === 'string';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    default:
      return true;
  }
}

function formatType(type: unknown): string {
  return Array.isArray(type) ? type.map((item) => String(item)).join(' or ') : String(type);
}

function isSchema(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value);
}

function isSchemaMap(value: unknown): value is Record<string, Record<string, unknown>> {
  return isPlainObject(value) && Object.values(value).every((child) => isSchema(child));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function escapePath(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
