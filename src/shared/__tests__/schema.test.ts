import { describe, it, expect, vi } from 'vitest';

import {
  isFieldVisible,
  getVisibleFields,
  filterVisibleFields,
} from '../schema';

// ---------------------------------------------------------------------------
// isFieldVisible
// ---------------------------------------------------------------------------

describe('isFieldVisible', () => {
  describe('hidden visibility', () => {
    it('never visible regardless of auth/admin', () => {
      expect(isFieldVisible('secret', 'hidden', true, true)).toBe(false);
      expect(isFieldVisible('secret', 'hidden', false, true)).toBe(false);
      expect(isFieldVisible('secret', 'hidden', true, false)).toBe(false);
      expect(isFieldVisible('secret', 'hidden', false, false)).toBe(false);
    });
  });

  describe('guest visibility', () => {
    it('always visible regardless of auth/admin', () => {
      expect(isFieldVisible('title', 'guest', true, true)).toBe(true);
      expect(isFieldVisible('title', 'guest', false, true)).toBe(true);
      expect(isFieldVisible('title', 'guest', true, false)).toBe(true);
      expect(isFieldVisible('title', 'guest', false, false)).toBe(true);
    });
  });

  describe('admin visibility', () => {
    it('visible only to admins', () => {
      expect(isFieldVisible('config', 'admin', true, true)).toBe(true);
      expect(isFieldVisible('config', 'admin', false, true)).toBe(false);
      expect(isFieldVisible('config', 'admin', true, false)).toBe(true);
      expect(isFieldVisible('config', 'admin', false, false)).toBe(false);
    });
  });

  describe('technical visibility', () => {
    it('visible only to admins', () => {
      expect(isFieldVisible('debug', 'technical', true)).toBe(true);
      expect(isFieldVisible('debug', 'technical', false)).toBe(false);
    });
  });

  describe('owner visibility', () => {
    it('returns false in aggregate context', () => {
      expect(isFieldVisible('email', 'owner', true, true)).toBe(false);
      expect(isFieldVisible('email', 'owner', false, true)).toBe(false);
    });
  });

  describe('user visibility', () => {
    it('visible to authenticated users', () => {
      expect(isFieldVisible('profile', 'user', false, true)).toBe(true);
      expect(isFieldVisible('profile', 'user', false, false)).toBe(false);
    });

    it('visible to admins', () => {
      expect(isFieldVisible('profile', 'user', true, true)).toBe(true);
    });
  });

  describe('undefined visibility (defaults to user)', () => {
    it('visible to authenticated users', () => {
      expect(isFieldVisible('field', undefined, false, true)).toBe(true);
      expect(isFieldVisible('field', undefined, false, false)).toBe(false);
    });

    it('defaults isAuthenticated to true', () => {
      expect(isFieldVisible('field', undefined, false)).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// getVisibleFields
// ---------------------------------------------------------------------------

describe('getVisibleFields', () => {
  it('returns empty array for non-object schema', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(getVisibleFields(null, false)).toEqual([]);
    expect(getVisibleFields('string', false)).toEqual([]);
    expect(getVisibleFields({}, false)).toEqual([]);

    warnSpy.mockRestore();
  });

  it('returns all fields without visibility for authenticated user', () => {
    const schema = {
      entries: {
        name: {},
        email: {},
      },
    };

    const result = getVisibleFields(schema, false);

    expect(result).toContain('name');
    expect(result).toContain('email');
  });

  it('excludes hidden fields', () => {
    const schema = {
      entries: {
        name: {},
        password: { visibility: 'hidden' },
      },
    };

    const result = getVisibleFields(schema, true);

    expect(result).toContain('name');
    expect(result).not.toContain('password');
  });

  it('includes admin fields only for admins', () => {
    const schema = {
      entries: {
        name: {},
        config: { visibility: 'admin' },
      },
    };

    expect(getVisibleFields(schema, true)).toContain('config');
    expect(getVisibleFields(schema, false)).not.toContain('config');
  });

  it('includes guest fields for everyone', () => {
    const schema = {
      entries: {
        title: { visibility: 'guest' },
      },
    };

    expect(getVisibleFields(schema, false)).toContain('title');
    expect(getVisibleFields(schema, true)).toContain('title');
  });
});

// ---------------------------------------------------------------------------
// filterVisibleFields
// ---------------------------------------------------------------------------

describe('filterVisibleFields', () => {
  it('returns empty object for null data', () => {
    const schema = { entries: { name: {} } };

    expect(filterVisibleFields(null, schema, false)).toEqual({});
  });

  it('returns empty object for undefined data', () => {
    const schema = { entries: { name: {} } };

    expect(filterVisibleFields(undefined, schema, false)).toEqual({});
  });

  it('filters data to only visible fields', () => {
    const schema = {
      entries: {
        name: { visibility: 'guest' },
        secret: { visibility: 'hidden' },
        config: { visibility: 'admin' },
      },
    };

    const data = { name: 'Alice', secret: 'pw123', config: 'x', extra: 'y' };

    const result = filterVisibleFields(data, schema, false);

    expect(result).toEqual({ name: 'Alice' });
  });

  it('includes admin fields when isAdmin is true', () => {
    const schema = {
      entries: {
        name: { visibility: 'guest' },
        config: { visibility: 'admin' },
      },
    };

    const data = { name: 'Alice', config: 'x' };
    const result = filterVisibleFields(data, schema, true);

    expect(result).toEqual({ name: 'Alice', config: 'x' });
  });

  it('ignores data keys not in schema', () => {
    const schema = {
      entries: {
        name: {},
      },
    };

    const data = { name: 'Alice', extraField: 'ignored' };
    const result = filterVisibleFields(data, schema, false);

    expect(result).toEqual({ name: 'Alice' });
  });

  it('handles missing data keys gracefully', () => {
    const schema = {
      entries: {
        name: {},
        missing: {},
      },
    };

    const data = { name: 'Alice' };
    const result = filterVisibleFields(data, schema, false);

    expect(result).toEqual({ name: 'Alice' });
    expect(result).not.toHaveProperty('missing');
  });
});
