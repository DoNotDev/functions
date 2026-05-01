// packages/functions/src/shared/utils/internal/rateLimiter.ts

/**
 * @fileoverview Server-side rate limiting utilities
 * @description Rate limiting implementation for Firebase Functions and Vercel
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';

import type {
  ServerRateLimitConfig as RateLimitConfig,
  ServerRateLimitResult as RateLimitResult,
} from '@donotdev/core';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

export type { RateLimitConfig, RateLimitResult };

interface RateLimitEntry {
  attempts: number;
  windowStart: number;
  blockUntil: number | null;
}

// In-memory storage for rate limiting (in production, use Redis or Firestore)
const rateLimitStore = new Map<string, RateLimitEntry>();

/**
 * Check rate limit for a given key using in-memory storage
 * For production, this should be replaced with Redis or Firestore
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function checkRateLimit(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  // Check if currently blocked
  if (entry?.blockUntil && now < entry.blockUntil) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(entry.blockUntil),
      blockRemainingSeconds: Math.ceil((entry.blockUntil - now) / 1000),
    };
  }

  // Clean up expired entries
  if (entry && now >= entry.windowStart + config.windowMs) {
    rateLimitStore.delete(key);
  }

  const currentEntry = rateLimitStore.get(key) || {
    attempts: 0,
    windowStart: now,
    blockUntil: null,
  };

  // Check if limit exceeded
  if (currentEntry.attempts >= config.maxAttempts) {
    // Apply block
    currentEntry.blockUntil = now + config.blockDurationMs;
    rateLimitStore.set(key, currentEntry);

    logger.warn('Rate limit exceeded', {
      key,
      attempts: currentEntry.attempts,
      blockUntil: new Date(currentEntry.blockUntil),
    });

    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(currentEntry.blockUntil),
      blockRemainingSeconds: Math.ceil(config.blockDurationMs / 1000),
    };
  }

  // Record attempt
  currentEntry.attempts += 1;
  rateLimitStore.set(key, currentEntry);

  return {
    allowed: true,
    remaining: config.maxAttempts - currentEntry.attempts,
    resetAt: new Date(currentEntry.windowStart + config.windowMs),
    blockRemainingSeconds: null,
  };
}

/**
 * Check rate limit using Firestore for persistent storage.
 * This is the recommended approach for production.
 *
 * **Architecture decision — Firestore transaction for rate limiting:**
 * The read-modify-write cycle is wrapped in a Firestore transaction to
 * eliminate TOCTOU races. While transactions add some latency, rate limiting
 * is a best-effort abuse-prevention mechanism, not a hard security boundary.
 * The window-based approach (maxAttempts per windowMs) tolerates minor
 * timing variations. If transaction contention becomes an issue under extreme
 * load, the catch block fails open (allows the request) to avoid blocking
 * legitimate traffic — this is an intentional trade-off favoring availability
 * over strict enforcement.
 *
 * For stricter rate limiting (e.g. payment endpoints), consumers can use
 * Redis-backed rate limiters or API gateway-level throttling.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function checkRateLimitWithFirestore(
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const db = getFirebaseAdminFirestore();
  const rateLimitRef = db.collection('rateLimits').doc(key);

  try {
    const now = Date.now();

    // W2: Wrap the entire read-modify-write in a Firestore transaction to
    // eliminate the TOCTOU race where two concurrent requests both read the
    // same counter and both increment it independently.
    let result: RateLimitResult = {
      allowed: true,
      remaining: config.maxAttempts - 1,
      resetAt: new Date(now + config.windowMs),
      blockRemainingSeconds: null,
    };

    await db.runTransaction(async (tx) => {
      const doc = await tx.get(rateLimitRef);

      if (!doc.exists) {
        tx.set(rateLimitRef, {
          attempts: 1,
          windowStart: now,
          blockUntil: null,
          lastUpdated: now,
        });
        result = {
          allowed: true,
          remaining: config.maxAttempts - 1,
          resetAt: new Date(now + config.windowMs),
          blockRemainingSeconds: null,
        };
        return;
      }

      const data = doc.data() as RateLimitEntry & { lastUpdated: number };

      // Check if currently blocked
      if (data.blockUntil && now < data.blockUntil) {
        result = {
          allowed: false,
          remaining: 0,
          resetAt: new Date(data.blockUntil),
          blockRemainingSeconds: Math.ceil((data.blockUntil - now) / 1000),
        };
        return;
      }

      // Check if window expired — reset
      if (now >= data.windowStart + config.windowMs) {
        tx.set(rateLimitRef, {
          attempts: 1,
          windowStart: now,
          blockUntil: null,
          lastUpdated: now,
        });
        result = {
          allowed: true,
          remaining: config.maxAttempts - 1,
          resetAt: new Date(now + config.windowMs),
          blockRemainingSeconds: null,
        };
        return;
      }

      // Check if limit exceeded
      if (data.attempts >= config.maxAttempts) {
        const blockUntil = now + config.blockDurationMs;
        tx.update(rateLimitRef, { blockUntil, lastUpdated: now });

        logger.warn('Rate limit exceeded (Firestore)', {
          key,
          attempts: data.attempts,
          blockUntil: new Date(blockUntil),
        });

        result = {
          allowed: false,
          remaining: 0,
          resetAt: new Date(blockUntil),
          blockRemainingSeconds: Math.ceil(config.blockDurationMs / 1000),
        };
        return;
      }

      // Increment attempts
      tx.update(rateLimitRef, {
        attempts: data.attempts + 1,
        lastUpdated: now,
      });
      result = {
        allowed: true,
        remaining: config.maxAttempts - (data.attempts + 1),
        resetAt: new Date(data.windowStart + config.windowMs),
        blockRemainingSeconds: null,
      };
    });

    return result;
  } catch (error) {
    logger.error('Rate limit check failed', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed — deny the request if rate limiting infrastructure fails.
    // Aligns with the Supabase implementation's fail-closed policy.
    // Availability trade-off: legitimate requests may be blocked during
    // Firestore outages, but this prevents abuse when enforcement is down.
    return {
      allowed: false,
      remaining: 0,
      resetAt: null,
      blockRemainingSeconds: null,
    };
  }
}

/**
 * Reset rate limit for a given key
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function resetRateLimit(key: string): void {
  rateLimitStore.delete(key);
  logger.info('Rate limit reset', { key });
}

/**
 * Reset rate limit in Firestore
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function resetRateLimitInFirestore(key: string): Promise<void> {
  const db = getFirebaseAdminFirestore();
  const rateLimitRef = db.collection('rateLimits').doc(key);

  try {
    await rateLimitRef.delete();
    logger.info('Rate limit reset (Firestore)', { key });
  } catch (error) {
    logger.error('Failed to reset rate limit', {
      key,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get rate limit status without consuming an attempt
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getRateLimitStatus(
  key: string,
  config: RateLimitConfig
): RateLimitResult {
  const now = Date.now();
  const entry = rateLimitStore.get(key);

  if (!entry) {
    return {
      allowed: true,
      remaining: config.maxAttempts,
      resetAt: null,
      blockRemainingSeconds: null,
    };
  }

  // Check if currently blocked
  if (entry.blockUntil && now < entry.blockUntil) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: new Date(entry.blockUntil),
      blockRemainingSeconds: Math.ceil((entry.blockUntil - now) / 1000),
    };
  }

  // Check if window expired
  if (now >= entry.windowStart + config.windowMs) {
    return {
      allowed: true,
      remaining: config.maxAttempts,
      resetAt: null,
      blockRemainingSeconds: null,
    };
  }

  return {
    allowed: entry.attempts < config.maxAttempts,
    remaining: Math.max(0, config.maxAttempts - entry.attempts),
    resetAt: new Date(entry.windowStart + config.windowMs),
    blockRemainingSeconds: null,
  };
}

/**
 * Default rate limit configurations for common operations
 */
export const DEFAULT_RATE_LIMITS = {
  checkout: {
    maxAttempts: 5,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 5 * 60 * 1000, // 5 minutes
  },
  webhook: {
    maxAttempts: 100,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 60 * 1000, // 1 minute
  },
  auth: {
    maxAttempts: 10,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 5 * 60 * 1000, // 5 minutes
  },
  api: {
    maxAttempts: 100,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 60 * 1000, // 1 minute
  },
} as const;
