import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { createMetadata, updateMetadata } from '../metadata';

describe('createMetadata', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-13T10:00:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns all four metadata fields', () => {
    const result = createMetadata('user-123');

    expect(result).toEqual({
      createdAt: '2026-03-13T10:00:00.000Z',
      updatedAt: '2026-03-13T10:00:00.000Z',
      createdById: 'user-123',
      updatedById: 'user-123',
    });
  });

  it('sets createdAt and updatedAt to the same value', () => {
    const result = createMetadata('any');

    expect(result.createdAt).toBe(result.updatedAt);
  });

  it('uses ISO 8601 format', () => {
    const result = createMetadata('u');

    expect(result.createdAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
    );
  });
});

describe('updateMetadata', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-15T14:30:00.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns only update fields', () => {
    const result = updateMetadata('user-456');

    expect(result).toEqual({
      updatedAt: '2026-06-15T14:30:00.000Z',
      updatedById: 'user-456',
    });
  });

  it('does not include creation fields', () => {
    const result = updateMetadata('u') as any;

    expect(result.createdAt).toBeUndefined();
    expect(result.createdById).toBeUndefined();
  });
});
