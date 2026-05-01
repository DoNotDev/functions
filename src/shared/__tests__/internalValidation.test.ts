import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as v from 'valibot';

// Mock external deps
vi.mock('@donotdev/core/server', () => {
  class DoNotDevError extends Error {
    code: string;
    details: any;
    constructor(message: string, code: string = 'internal', opts?: any) {
      super(message);
      this.name = 'DoNotDevError';
      this.code = code;
      this.details = opts?.details;
    }
  }
  return { DoNotDevError };
});

import {
  safeJsonParse,
  validateCollectionName,
  validateDocument,
  validateStripeEnvironment,
} from '../utils/internal/validation';

import { DoNotDevError } from '@donotdev/core/server';

// ---------------------------------------------------------------------------
// safeJsonParse
// ---------------------------------------------------------------------------

describe('safeJsonParse', () => {
  it('parses valid JSON', () => {
    expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 });
  });

  it('parses JSON array', () => {
    expect(safeJsonParse('[1,2,3]')).toEqual([1, 2, 3]);
  });

  it('parses JSON string', () => {
    expect(safeJsonParse('"hello"')).toBe('hello');
  });

  it('parses JSON number', () => {
    expect(safeJsonParse('42')).toBe(42);
  });

  it('returns null for invalid JSON', () => {
    expect(safeJsonParse('{invalid}')).toBe(null);
  });

  it('returns null for empty string', () => {
    expect(safeJsonParse('')).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// validateCollectionName (internal version)
// ---------------------------------------------------------------------------

describe('validateCollectionName (internal)', () => {
  it('accepts valid names', () => {
    expect(() => validateCollectionName('users')).not.toThrow();
    expect(() => validateCollectionName('my-collection')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateCollectionName('')).toThrow(
      'Collection name is required'
    );
  });

  it('rejects non-string', () => {
    expect(() => validateCollectionName(null as any)).toThrow(
      'Collection name is required'
    );
    expect(() => validateCollectionName(undefined as any)).toThrow(
      'Collection name is required'
    );
  });

  it('rejects path traversal with slash', () => {
    expect(() => validateCollectionName('a/b')).toThrow(
      'Invalid collection name'
    );
  });

  it('rejects path traversal with double dots', () => {
    expect(() => validateCollectionName('a..b')).toThrow(
      'Invalid collection name'
    );
  });

  it('rejects internal collections starting with underscore', () => {
    expect(() => validateCollectionName('_system')).toThrow(
      'Invalid collection name'
    );
  });
});

// ---------------------------------------------------------------------------
// validateDocument (internal version - throws DoNotDevError)
// ---------------------------------------------------------------------------

describe('validateDocument (internal)', () => {
  it('accepts valid object', () => {
    expect(() => validateDocument({ name: 'test' })).not.toThrow();
  });

  it('throws DoNotDevError for null', () => {
    try {
      validateDocument(null);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as any).code).toBe('invalid-argument');
    }
  });

  it('throws DoNotDevError for array', () => {
    try {
      validateDocument([1, 2]);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as any).message).toBe('Document data cannot be an array');
    }
  });

  it('validates against valibot schema when provided', () => {
    const schema = v.object({
      name: v.pipe(v.string(), v.minLength(1)),
    });

    expect(() => validateDocument({ name: 'valid' }, schema)).not.toThrow();
  });

  it('throws DoNotDevError with validation details for invalid schema data', () => {
    const schema = v.object({
      name: v.pipe(v.string(), v.minLength(1)),
    });

    try {
      validateDocument({ name: '' }, schema);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as any).code).toBe('invalid-argument');
      expect((error as any).message).toContain('Validation failed');
      expect((error as any).details).toBeDefined();
    }
  });

  it('passes without schema (no validation beyond type check)', () => {
    expect(() => validateDocument({ anything: 'goes' })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// validateStripeEnvironment (internal version)
// ---------------------------------------------------------------------------

describe('validateStripeEnvironment (internal)', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
    delete process.env.STRIPE_WEBHOOK_SECRET;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('throws when both vars missing', () => {
    expect(() => validateStripeEnvironment()).toThrow(
      'Missing required environment variables'
    );
    expect(() => validateStripeEnvironment()).toThrow('STRIPE_SECRET_KEY');
    expect(() => validateStripeEnvironment()).toThrow('STRIPE_WEBHOOK_SECRET');
  });

  it('throws when STRIPE_WEBHOOK_SECRET missing', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';

    expect(() => validateStripeEnvironment()).toThrow('STRIPE_WEBHOOK_SECRET');
  });

  it('passes when all vars set', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_x';
    process.env.STRIPE_WEBHOOK_SECRET = 'whsec_x';

    expect(() => validateStripeEnvironment()).not.toThrow();
  });
});
