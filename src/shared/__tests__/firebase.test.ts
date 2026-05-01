import { describe, it, expect } from 'vitest';

import {
  createTimestamp,
  toTimestamp,
  toISOString,
  isTimestamp,
  transformFirestoreData,
  prepareForFirestore,
} from '../firebase';

// ---------------------------------------------------------------------------
// createTimestamp
// ---------------------------------------------------------------------------

describe('createTimestamp', () => {
  it('converts Date to timestamp with correct seconds and nanoseconds', () => {
    const date = new Date('2026-01-15T12:00:00.500Z');
    const ts = createTimestamp(date);

    expect(ts.seconds).toBe(Math.floor(date.getTime() / 1000));
    expect(ts.nanoseconds).toBe(500 * 1_000_000);
  });

  it('toDate returns equivalent Date', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const ts = createTimestamp(date);

    expect(ts.toDate().getTime()).toBe(date.getTime());
  });

  it('toMillis returns epoch milliseconds', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const ts = createTimestamp(date);

    expect(ts.toMillis()).toBe(date.getTime());
  });

  it('isEqual returns true for identical timestamps', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const ts1 = createTimestamp(date);
    const ts2 = createTimestamp(date);

    expect(ts1.isEqual(ts2)).toBe(true);
  });

  it('isEqual returns false for different timestamps', () => {
    const ts1 = createTimestamp(new Date('2026-01-15T12:00:00.000Z'));
    const ts2 = createTimestamp(new Date('2026-01-16T12:00:00.000Z'));

    expect(ts1.isEqual(ts2)).toBe(false);
  });

  it('valueOf returns formatted string', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const ts = createTimestamp(date);

    expect(ts.valueOf()).toContain('Timestamp(seconds=');
    expect(ts.valueOf()).toContain('nanoseconds=');
  });

  it('handles epoch zero', () => {
    const date = new Date(0);
    const ts = createTimestamp(date);

    expect(ts.seconds).toBe(0);
    expect(ts.nanoseconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// toTimestamp
// ---------------------------------------------------------------------------

describe('toTimestamp', () => {
  it('converts ISO string to timestamp', () => {
    const ts = toTimestamp('2026-01-15T12:00:00.000Z');

    expect(ts.seconds).toBe(
      Math.floor(new Date('2026-01-15T12:00:00.000Z').getTime() / 1000)
    );
  });

  it('converts Date object to timestamp', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const ts = toTimestamp(date);

    expect(ts.toDate().getTime()).toBe(date.getTime());
  });

  it('throws for invalid date string', () => {
    expect(() => toTimestamp('not-a-date')).toThrow(
      'Failed to convert to timestamp'
    );
  });

  it('throws for invalid Date object', () => {
    expect(() => toTimestamp(new Date('invalid'))).toThrow(
      'Failed to convert to timestamp'
    );
  });
});

// ---------------------------------------------------------------------------
// toISOString
// ---------------------------------------------------------------------------

describe('toISOString', () => {
  it('converts timestamp to ISO string', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const ts = createTimestamp(date);

    expect(toISOString(ts)).toBe('2026-01-15T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// isTimestamp
// ---------------------------------------------------------------------------

describe('isTimestamp', () => {
  it('returns true for valid timestamp object', () => {
    const ts = createTimestamp(new Date());

    expect(isTimestamp(ts)).toBe(true);
  });

  it('returns falsy for null', () => {
    expect(isTimestamp(null)).toBeFalsy();
  });

  it('returns falsy for undefined', () => {
    expect(isTimestamp(undefined)).toBeFalsy();
  });

  it('returns false for plain object', () => {
    expect(isTimestamp({ seconds: 1, nanoseconds: 0 })).toBe(false);
  });

  it('returns false for string', () => {
    expect(isTimestamp('2026-01-01')).toBe(false);
  });

  it('returns false for number', () => {
    expect(isTimestamp(12345)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// transformFirestoreData
// ---------------------------------------------------------------------------

describe('transformFirestoreData', () => {
  it('returns falsy values unchanged', () => {
    expect(transformFirestoreData(null)).toBe(null);
    expect(transformFirestoreData(undefined)).toBe(undefined);
    expect(transformFirestoreData(0)).toBe(0);
    expect(transformFirestoreData('')).toBe('');
  });

  it('returns primitive values unchanged', () => {
    expect(transformFirestoreData('hello')).toBe('hello');
    expect(transformFirestoreData(42)).toBe(42);
    expect(transformFirestoreData(true)).toBe(true);
  });

  it('converts timestamp fields to ISO strings', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const data = {
      name: 'test',
      createdAt: createTimestamp(date),
    };

    const result = transformFirestoreData(data);

    expect(result.name).toBe('test');
    expect(result.createdAt).toBe('2026-01-15T12:00:00.000Z');
  });

  it('handles nested objects with timestamps', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const data = {
      user: {
        profile: {
          lastLogin: createTimestamp(date),
        },
      },
    };

    const result = transformFirestoreData(data);

    expect(result.user.profile.lastLogin).toBe('2026-01-15T12:00:00.000Z');
  });

  it('handles arrays with timestamps', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const data = [createTimestamp(date), 'plain'];

    const result = transformFirestoreData(data);

    expect(result[0]).toBe('2026-01-15T12:00:00.000Z');
    expect(result[1]).toBe('plain');
  });

  it('handles mixed nested structures', () => {
    const date = new Date('2026-03-01T00:00:00.000Z');
    const data = {
      items: [
        { ts: createTimestamp(date), val: 1 },
        { ts: createTimestamp(date), val: 2 },
      ],
    };

    const result = transformFirestoreData(data);

    expect(result.items[0].ts).toBe('2026-03-01T00:00:00.000Z');
    expect(result.items[0].val).toBe(1);
    expect(result.items[1].ts).toBe('2026-03-01T00:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// prepareForFirestore
// ---------------------------------------------------------------------------

describe('prepareForFirestore', () => {
  it('returns falsy values unchanged', () => {
    expect(prepareForFirestore(null)).toBe(null);
    expect(prepareForFirestore(undefined)).toBe(undefined);
  });

  it('converts Date objects to ISO strings', () => {
    const date = new Date('2026-01-15T12:00:00.000Z');
    const data = { createdAt: date, name: 'test' };

    const result = prepareForFirestore(data);

    expect(result.createdAt).toBe('2026-01-15T12:00:00.000Z');
    expect(result.name).toBe('test');
  });

  it('converts root-level Date to empty object (Date is object, enters object branch)', () => {
    // Note: Date is typeof 'object', so it enters the object iteration branch
    // before reaching the root-level Date check. This is a known source quirk.
    const date = new Date('2026-01-15T12:00:00.000Z');

    const result = prepareForFirestore(date);

    expect(result).toEqual({});
  });

  it('removes specified fields', () => {
    const data = { keep: 'yes', remove: 'no', alsoKeep: 1 };

    const result = prepareForFirestore(data, ['remove']);

    expect(result).toEqual({ keep: 'yes', alsoKeep: 1 });
    expect(result).not.toHaveProperty('remove');
  });

  it('handles nested objects with Dates', () => {
    const date = new Date('2026-06-01T00:00:00.000Z');
    const data = {
      user: {
        lastLogin: date,
        name: 'Alice',
      },
    };

    const result = prepareForFirestore(data);

    expect(result.user.lastLogin).toBe('2026-06-01T00:00:00.000Z');
    expect(result.user.name).toBe('Alice');
  });

  it('handles arrays with Dates', () => {
    const date = new Date('2026-01-01T00:00:00.000Z');
    const data = [{ ts: date }, { ts: date }];

    const result = prepareForFirestore(data);

    expect(result[0].ts).toBe('2026-01-01T00:00:00.000Z');
    expect(result[1].ts).toBe('2026-01-01T00:00:00.000Z');
  });

  it('leaves strings as-is', () => {
    const data = { iso: '2026-01-15T12:00:00.000Z', text: 'hello' };

    const result = prepareForFirestore(data);

    expect(result).toEqual(data);
  });

  it('returns primitives unchanged', () => {
    expect(prepareForFirestore(42)).toBe(42);
    expect(prepareForFirestore('hello')).toBe('hello');
    expect(prepareForFirestore(true)).toBe(true);
  });
});
