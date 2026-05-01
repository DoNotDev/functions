import { describe, it, expect, vi, beforeEach } from 'vitest';

import { handleError, DoNotDevError } from '../errorHandling';

describe('DoNotDevError (functions)', () => {
  it('creates with default code "internal"', () => {
    const error = new DoNotDevError('test');

    expect(error.code).toBe('internal');
    expect(error.message).toBe('test');
    expect(error.name).toBe('DoNotDevError');
  });

  it('creates with explicit code and details', () => {
    const error = new DoNotDevError('bad input', 'invalid-argument', {
      details: { field: 'email' },
    });

    expect(error.code).toBe('invalid-argument');
    expect(error.details).toEqual({ field: 'email' });
  });

  it('toString formats correctly', () => {
    const error = new DoNotDevError('test', 'not-found');

    expect(error.toString()).toBe('DoNotDevError [not-found]: test');
  });

  it('instanceof chain works', () => {
    const error = new DoNotDevError('test');

    expect(error instanceof DoNotDevError).toBe(true);
    expect(error instanceof Error).toBe(true);
  });
});

describe('handleError', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('throws DoNotDevError for DoNotDevError input', () => {
    const original = new DoNotDevError('Bad', 'invalid-argument');

    try {
      handleError(original);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as DoNotDevError).code).toBe('invalid-argument');
      expect((error as DoNotDevError).message).toBe('Bad');
    }
  });

  it('preserves details from DoNotDevError input', () => {
    const original = new DoNotDevError('Bad', 'invalid-argument', {
      details: { field: 'email' },
    });

    try {
      handleError(original);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as DoNotDevError).details).toEqual({ field: 'email' });
    }
  });

  it('throws DoNotDevError with code "internal" for generic Error', () => {
    try {
      handleError(new Error('Something broke'));
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as DoNotDevError).code).toBe('internal');
      expect((error as DoNotDevError).message).toBe('Something broke');
    }
  });

  it('throws DoNotDevError with generic message for non-Error', () => {
    try {
      handleError('random string');
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as DoNotDevError).code).toBe('internal');
      expect((error as DoNotDevError).message).toBe(
        'An unexpected error occurred'
      );
    }
  });

  it('maps EntityHookError PERMISSION_DENIED', () => {
    const entityError = new Error('Permission denied');
    (entityError as any).name = 'EntityHookError';
    (entityError as any).type = 'PERMISSION_DENIED';

    try {
      handleError(entityError);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as DoNotDevError).code).toBe('permission-denied');
      expect((error as DoNotDevError).message).toBe('Permission denied');
    }
  });

  it('maps EntityHookError NOT_FOUND', () => {
    const entityError = new Error('Not found');
    (entityError as any).name = 'EntityHookError';
    (entityError as any).type = 'NOT_FOUND';

    try {
      handleError(entityError);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DoNotDevError).code).toBe('not-found');
    }
  });

  it('maps EntityHookError ALREADY_EXISTS', () => {
    const entityError = new Error('Exists');
    (entityError as any).name = 'EntityHookError';
    (entityError as any).type = 'ALREADY_EXISTS';

    try {
      handleError(entityError);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DoNotDevError).code).toBe('already-exists');
    }
  });

  it('maps EntityHookError VALIDATION_ERROR', () => {
    const entityError = new Error('Invalid');
    (entityError as any).name = 'EntityHookError';
    (entityError as any).type = 'VALIDATION_ERROR';

    try {
      handleError(entityError);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DoNotDevError).code).toBe('invalid-argument');
    }
  });

  it('maps EntityHookError NETWORK_ERROR', () => {
    const entityError = new Error('Network');
    (entityError as any).name = 'EntityHookError';
    (entityError as any).type = 'NETWORK_ERROR';

    try {
      handleError(entityError);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DoNotDevError).code).toBe('unavailable');
    }
  });

  it('maps unknown EntityHookError type to internal', () => {
    const entityError = new Error('Unknown');
    (entityError as any).name = 'EntityHookError';
    (entityError as any).type = 'SOME_FUTURE_TYPE';

    try {
      handleError(entityError);
      expect.fail('should have thrown');
    } catch (error) {
      expect((error as DoNotDevError).code).toBe('internal');
    }
  });

  it('maps ValiError to invalid-argument with details', () => {
    const valiError = new Error('Validation failed');
    (valiError as any).name = 'ValiError';
    (valiError as any).issues = [{ path: [], message: 'required' }];

    try {
      handleError(valiError);
      expect.fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DoNotDevError);
      expect((error as DoNotDevError).code).toBe('invalid-argument');
      expect((error as DoNotDevError).message).toBe('Validation failed');
      expect((error as DoNotDevError).details).toEqual({
        validationErrors: [{ path: [], message: 'required' }],
      });
    }
  });
});
