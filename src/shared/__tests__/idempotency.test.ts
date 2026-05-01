import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock detectFirestore to return false (force in-memory)
vi.mock('../utils/detectFirestore.js', () => ({
  isFirestoreConfigured: vi.fn(() => false),
}));

import {
  createIdempotencyStore,
  resetIdempotencyStore,
} from '../billing/idempotency';

describe('InMemoryIdempotency', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('creates in-memory store when Firestore not configured', () => {
    const store = createIdempotencyStore();

    expect(store).toBeDefined();
    expect(typeof store.isProcessed).toBe('function');
    expect(typeof store.markProcessed).toBe('function');
  });

  it('returns singleton instance', () => {
    const store1 = createIdempotencyStore();
    const store2 = createIdempotencyStore();

    expect(store1).toBe(store2);
  });

  it('reports event as not processed initially', async () => {
    const store = createIdempotencyStore();

    const result = await store.isProcessed('evt_001');
    expect(result).toBe(false);
  });

  it('reports event as processed after marking', async () => {
    const store = createIdempotencyStore();

    await store.markProcessed('evt_002');
    const result = await store.isProcessed('evt_002');

    expect(result).toBe(true);
  });

  it('distinguishes between different events', async () => {
    const store = createIdempotencyStore();

    await store.markProcessed('evt_a');

    expect(await store.isProcessed('evt_a')).toBe(true);
    expect(await store.isProcessed('evt_b')).toBe(false);
  });

  it('warns once on first isProcessed call', async () => {
    const warnSpy = vi.spyOn(console, 'warn');
    const store = createIdempotencyStore();

    await store.isProcessed('evt_x');
    await store.isProcessed('evt_y');

    // Should warn at least once about in-memory usage
    const inMemoryWarns = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('in-memory')
    );
    expect(inMemoryWarns.length).toBeGreaterThanOrEqual(1);
  });

  it('auto-cleans after 1000 entries (keeps last entries)', async () => {
    const store = createIdempotencyStore();

    // Add 1001 entries
    for (let i = 0; i < 1001; i++) {
      await store.markProcessed(`evt_${i}`);
    }

    // First entry should have been evicted
    expect(await store.isProcessed('evt_0')).toBe(false);
    // Recent entry should still exist
    expect(await store.isProcessed('evt_1000')).toBe(true);
  });

  it('resetIdempotencyStore clears singleton', () => {
    const store1 = createIdempotencyStore();
    resetIdempotencyStore();
    const store2 = createIdempotencyStore();

    expect(store1).not.toBe(store2);
  });
});
