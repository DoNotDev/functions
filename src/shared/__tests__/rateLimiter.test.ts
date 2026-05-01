import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-functions/v2 logger
vi.mock('firebase-functions/v2', () => ({
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  },
}));

// Mock @donotdev/firebase/server (not used in in-memory path, but imported)
vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: vi.fn(),
}));

import {
  checkRateLimit,
  resetRateLimit,
  getRateLimitStatus,
  DEFAULT_RATE_LIMITS,
} from '../utils/internal/rateLimiter';

const TEST_CONFIG = {
  maxAttempts: 3,
  windowMs: 60_000,
  blockDurationMs: 300_000,
};

describe('checkRateLimit (in-memory)', () => {
  beforeEach(() => {
    // Reset rate limit store between tests
    resetRateLimit('test-key');
    resetRateLimit('other-key');
  });

  it('allows first request', async () => {
    const result = await checkRateLimit('test-key', TEST_CONFIG);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2); // 3 max - 1 used
    expect(result.blockRemainingSeconds).toBeNull();
  });

  it('decrements remaining on each request', async () => {
    await checkRateLimit('test-key', TEST_CONFIG);
    const result = await checkRateLimit('test-key', TEST_CONFIG);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(1); // 3 max - 2 used
  });

  it('blocks after max attempts exceeded', async () => {
    // Use all 3 attempts
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);

    // 4th request should be blocked
    const result = await checkRateLimit('test-key', TEST_CONFIG);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.blockRemainingSeconds).toBeGreaterThan(0);
    expect(result.resetAt).toBeInstanceOf(Date);
  });

  it('isolates keys from each other', async () => {
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);

    // Different key should still be allowed
    const result = await checkRateLimit('other-key', TEST_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });
});

describe('resetRateLimit', () => {
  it('clears rate limit allowing new requests', async () => {
    // Exhaust attempts
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);

    // Reset
    resetRateLimit('test-key');

    // Should be allowed again
    const result = await checkRateLimit('test-key', TEST_CONFIG);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });
});

describe('getRateLimitStatus', () => {
  beforeEach(() => {
    resetRateLimit('test-key');
  });

  it('returns full remaining for unknown key', () => {
    const result = getRateLimitStatus('unknown-key', TEST_CONFIG);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
    expect(result.resetAt).toBeNull();
    expect(result.blockRemainingSeconds).toBeNull();
  });

  it('reflects current usage without consuming attempt', async () => {
    await checkRateLimit('test-key', TEST_CONFIG);
    await checkRateLimit('test-key', TEST_CONFIG);

    const status = getRateLimitStatus('test-key', TEST_CONFIG);
    expect(status.remaining).toBe(1);

    // Check again — should be same (no attempt consumed)
    const status2 = getRateLimitStatus('test-key', TEST_CONFIG);
    expect(status2.remaining).toBe(1);
  });
});

describe('DEFAULT_RATE_LIMITS', () => {
  it('has checkout config', () => {
    expect(DEFAULT_RATE_LIMITS.checkout.maxAttempts).toBe(5);
    expect(DEFAULT_RATE_LIMITS.checkout.windowMs).toBe(60_000);
  });

  it('has webhook config', () => {
    expect(DEFAULT_RATE_LIMITS.webhook.maxAttempts).toBe(100);
  });

  it('has auth config', () => {
    expect(DEFAULT_RATE_LIMITS.auth.maxAttempts).toBe(10);
  });

  it('has api config', () => {
    expect(DEFAULT_RATE_LIMITS.api.maxAttempts).toBe(100);
  });
});
