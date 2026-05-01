import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  afterAll,
} from 'vitest';

// Mock external dependencies that utils.ts imports at module level
vi.mock('stripe', () => ({
  default: vi.fn(),
}));
vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: vi.fn(),
  getFirebaseAdminFirestore: vi.fn(),
  initFirebaseAdmin: vi.fn(),
}));
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
    toString() {
      return `DoNotDevError [${this.code}]: ${this.message}`;
    }
  }
  return { DoNotDevError };
});
vi.mock('../utils/internal/auth.js', () => ({
  assertAuthenticated: vi.fn((uid: string) => uid),
  assertAdmin: vi.fn((uid: string) => Promise.resolve(uid)),
}));

import {
  getUserRole,
  createSuccessResponse,
  createErrorResponse,
  validateDocument,
  validateCollectionName,
  assertAuthenticated,
  validateStripeEnvironment,
} from '../utils';

// Need to import DoNotDevError from the mocked module for instanceof checks
import { DoNotDevError } from '@donotdev/core/server';

// ---------------------------------------------------------------------------
// getUserRole
// ---------------------------------------------------------------------------

describe('getUserRole', () => {
  it('returns "guest" when auth is null', () => {
    expect(getUserRole(null)).toBe('guest');
  });

  it('returns "guest" when auth is undefined', () => {
    expect(getUserRole(undefined)).toBe('guest');
  });

  it('returns "guest" when auth.uid is missing', () => {
    expect(getUserRole({})).toBe('guest');
    expect(getUserRole({ uid: '' })).toBe('guest');
  });

  it('returns "super" when token.role is "super"', () => {
    expect(getUserRole({ uid: 'u1', token: { role: 'super' } })).toBe('super');
  });

  it('returns "admin" when token.role is "admin"', () => {
    expect(getUserRole({ uid: 'u1', token: { role: 'admin' } })).toBe('admin');
  });

  it('returns "super" via legacy isSuper flag', () => {
    expect(getUserRole({ uid: 'u1', token: { isSuper: true } })).toBe('super');
  });

  it('returns "admin" via legacy isAdmin flag', () => {
    expect(getUserRole({ uid: 'u1', token: { isAdmin: true } })).toBe('admin');
  });

  it('returns "user" for authenticated user without special claims', () => {
    expect(getUserRole({ uid: 'u1', token: {} })).toBe('user');
  });

  it('returns "user" when token is missing', () => {
    expect(getUserRole({ uid: 'u1' })).toBe('user');
  });

  it('prefers role string over legacy flags', () => {
    expect(
      getUserRole({ uid: 'u1', token: { role: 'admin', isSuper: true } })
    ).toBe('admin');
  });
});

// ---------------------------------------------------------------------------
// createSuccessResponse
// ---------------------------------------------------------------------------

describe('createSuccessResponse', () => {
  it('wraps data in success envelope', () => {
    const result = createSuccessResponse({ id: '123' });

    expect(result).toEqual({ success: true, data: { id: '123' } });
  });

  it('handles null data', () => {
    const result = createSuccessResponse(null);

    expect(result).toEqual({ success: true, data: null });
  });

  it('handles array data', () => {
    const result = createSuccessResponse([1, 2, 3]);

    expect(result).toEqual({ success: true, data: [1, 2, 3] });
  });
});

// ---------------------------------------------------------------------------
// createErrorResponse
// ---------------------------------------------------------------------------

describe('createErrorResponse', () => {
  it('formats DoNotDevError with code and details', () => {
    const error = new DoNotDevError('Bad input', 'invalid-argument', {
      details: { field: 'email' },
    });
    const result = createErrorResponse(error);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('invalid-argument');
    expect(result.error.message).toBe('Bad input');
    expect(result.error.details).toEqual({ field: 'email' });
  });

  it('formats generic Error as internal', () => {
    const result = createErrorResponse(new Error('oops'));

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('oops');
  });

  it('formats non-Error as internal with generic message', () => {
    const result = createErrorResponse('some string');

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('An unexpected error occurred');
  });

  it('formats null as internal with generic message', () => {
    const result = createErrorResponse(null);

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('internal');
    expect(result.error.message).toBe('An unexpected error occurred');
  });
});

// ---------------------------------------------------------------------------
// validateDocument
// ---------------------------------------------------------------------------

describe('validateDocument', () => {
  it('accepts valid object data', () => {
    expect(() => validateDocument({ name: 'test' })).not.toThrow();
  });

  it('rejects null', () => {
    expect(() => validateDocument(null)).toThrow('Invalid document data');
  });

  it('rejects undefined', () => {
    expect(() => validateDocument(undefined)).toThrow('Invalid document data');
  });

  it('rejects non-object', () => {
    expect(() => validateDocument('string')).toThrow('Invalid document data');
    expect(() => validateDocument(123)).toThrow('Invalid document data');
  });

  it('rejects arrays', () => {
    expect(() => validateDocument([1, 2])).toThrow(
      'Document data cannot be an array'
    );
  });
});

// ---------------------------------------------------------------------------
// validateCollectionName
// ---------------------------------------------------------------------------

describe('validateCollectionName', () => {
  it('accepts valid collection names', () => {
    expect(() => validateCollectionName('users')).not.toThrow();
    expect(() => validateCollectionName('myCollection')).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateCollectionName('')).toThrow(
      'Collection name is required'
    );
  });

  it('rejects names with slashes (path traversal)', () => {
    expect(() => validateCollectionName('users/admin')).toThrow(
      'Invalid collection name'
    );
  });

  it('rejects names with double dots (path traversal)', () => {
    expect(() => validateCollectionName('..users')).toThrow(
      'Invalid collection name'
    );
  });

  it('rejects names starting with underscore (internal collections)', () => {
    expect(() => validateCollectionName('_internal')).toThrow(
      'Invalid collection name'
    );
  });
});

// ---------------------------------------------------------------------------
// assertAuthenticated
// ---------------------------------------------------------------------------

describe('assertAuthenticated', () => {
  it('returns uid when auth has uid', () => {
    const result = assertAuthenticated({ uid: 'user-123' });

    expect(result).toBe('user-123');
  });

  it('throws when auth is null', () => {
    expect(() => assertAuthenticated(null)).toThrow(
      'User must be authenticated'
    );
  });

  it('throws when auth has no uid', () => {
    expect(() => assertAuthenticated({})).toThrow('User must be authenticated');
  });

  it('throws when auth.uid is empty string', () => {
    expect(() => assertAuthenticated({ uid: '' })).toThrow(
      'User must be authenticated'
    );
  });
});

// ---------------------------------------------------------------------------
// validateStripeEnvironment
// ---------------------------------------------------------------------------

describe('validateStripeEnvironment', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.STRIPE_SECRET_KEY;
  });

  afterAll(() => {
    process.env = { ...originalEnv };
  });

  it('throws when STRIPE_SECRET_KEY is missing', () => {
    expect(() => validateStripeEnvironment()).toThrow(
      'Missing STRIPE_SECRET_KEY'
    );
  });

  it('does not throw when STRIPE_SECRET_KEY is set', () => {
    process.env.STRIPE_SECRET_KEY = 'sk_test_123';

    expect(() => validateStripeEnvironment()).not.toThrow();
  });
});
