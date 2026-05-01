import { describe, it, expect } from 'vitest';
import * as v from 'valibot';

import { validateRequestData } from '../utils/schemaValidation';

const TestSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
  age: v.optional(v.pipe(v.number(), v.minValue(0))),
});

describe('validateRequestData', () => {
  it('returns success with parsed data for valid input', () => {
    const result = validateRequestData({ name: 'Alice', age: 30 }, TestSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: 'Alice', age: 30 });
    }
  });

  it('returns success when optional fields are missing', () => {
    const result = validateRequestData({ name: 'Alice' }, TestSchema);

    expect(result.success).toBe(true);
  });

  it('returns error for invalid input', () => {
    const result = validateRequestData({ name: '' }, TestSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain('Validation failed');
    }
  });

  it('returns error for completely wrong type', () => {
    const result = validateRequestData('not an object', TestSchema);

    expect(result.success).toBe(false);
  });

  it('returns error for null input', () => {
    const result = validateRequestData(null, TestSchema);

    expect(result.success).toBe(false);
  });

  it('uses custom schema when provided', () => {
    const strictSchema = v.object({
      name: v.pipe(v.string(), v.minLength(5)),
    });

    // Passes default but fails custom
    const result = validateRequestData(
      { name: 'Al' },
      TestSchema,
      strictSchema as any
    );

    expect(result.success).toBe(false);
  });

  it('uses default schema when custom is undefined', () => {
    const result = validateRequestData(
      { name: 'Alice' },
      TestSchema,
      undefined
    );

    expect(result.success).toBe(true);
  });
});
