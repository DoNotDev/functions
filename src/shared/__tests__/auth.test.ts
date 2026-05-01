import { describe, it, expect, vi } from 'vitest';

// Mock the external dependencies used by auth.ts
vi.mock('@donotdev/core/server', () => ({
  hasProvider: vi.fn(() => false),
  getProvider: vi.fn(),
}));
vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: vi.fn(),
}));

import { assertAuthenticated } from '../utils/internal/auth';

describe('assertAuthenticated', () => {
  it('returns uid for valid non-empty string', () => {
    expect(assertAuthenticated('user-123')).toBe('user-123');
  });

  it('throws for empty string', () => {
    expect(() => assertAuthenticated('')).toThrow('Authentication required');
  });

  it('throws for null', () => {
    expect(() => assertAuthenticated(null as any)).toThrow(
      'Authentication required'
    );
  });

  it('throws for undefined', () => {
    expect(() => assertAuthenticated(undefined as any)).toThrow(
      'Authentication required'
    );
  });

  it('throws for number (runtime type mismatch)', () => {
    expect(() => assertAuthenticated(123 as any)).toThrow(
      'Authentication required'
    );
  });

  it('throws for object (runtime type mismatch)', () => {
    expect(() => assertAuthenticated({} as any)).toThrow(
      'Authentication required'
    );
  });
});
