// packages/functions/src/supabase/utils/rateLimiter.ts

/**
 * @fileoverview Rate limiting utilities for Supabase Edge Functions
 * @description Postgres-based rate limiting via an atomic PostgreSQL function (RPC).
 *
 * **Why RPC?**
 * The previous SELECT → UPDATE pattern had a TOCTOU race condition: two concurrent
 * requests could both read `attempts < maxAttempts`, both increment, and both be allowed —
 * effectively bypassing the rate limit under load. The PostgreSQL function executes as a
 * single atomic transaction, eliminating the race.
 *
 * **Required migration:**
 * Deploy `RATE_LIMIT_CHECK_SQL` to your Supabase project before using this function.
 * Run: `supabase migration new rate_limit_check` then paste the SQL into the file.
 *
 * **Fail behaviour:**
 * On RPC error or unexpected failure, this function FAILS CLOSED (blocks the request).
 * A broken rate limiter must not silently allow unlimited access to protected resources.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type {
  ServerRateLimitConfig as RateLimitConfig,
  ServerRateLimitResult as RateLimitResult,
} from '@donotdev/core';

import type { SupabaseClient } from '@supabase/supabase-js';

export type { RateLimitConfig, RateLimitResult };

/**
 * PostgreSQL function required for atomic rate limiting.
 * Deploy this SQL to your Supabase project via a migration.
 *
 * The function uses `INSERT … ON CONFLICT DO UPDATE` which executes as a single
 * atomic statement — no TOCTOU race between SELECT and UPDATE.
 *
 * @example
 * ```bash
 * supabase migration new rate_limit_check
 * # Paste RATE_LIMIT_CHECK_SQL into the generated migration file
 * supabase db push
 * ```
 */
export const RATE_LIMIT_CHECK_SQL = `
-- Required table (create once if not already present)
CREATE TABLE IF NOT EXISTS public.rate_limits (
  key          TEXT PRIMARY KEY,
  attempts     INT           NOT NULL DEFAULT 0,
  window_start TIMESTAMPTZ   NOT NULL DEFAULT now(),
  block_until  TIMESTAMPTZ,
  last_updated TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Required atomic rate-limit function
CREATE OR REPLACE FUNCTION public.rate_limit_check(
  p_key              TEXT,
  p_max_attempts     INT,
  p_window_ms        BIGINT,
  p_block_duration_ms BIGINT
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_now             TIMESTAMPTZ := clock_timestamp();
  v_window_interval INTERVAL    := (p_window_ms || ' milliseconds')::INTERVAL;
  v_block_interval  INTERVAL    := (p_block_duration_ms || ' milliseconds')::INTERVAL;
  v_row             public.rate_limits%ROWTYPE;
BEGIN
  -- Single atomic upsert: INSERT on first call, conditional UPDATE thereafter.
  -- No separate SELECT → eliminates the TOCTOU race of the previous implementation.
  INSERT INTO public.rate_limits (key, attempts, window_start, block_until, last_updated)
  VALUES (p_key, 1, v_now, NULL, v_now)
  ON CONFLICT (key) DO UPDATE SET
    window_start = CASE
      WHEN rate_limits.window_start + v_window_interval <= v_now THEN v_now
      ELSE rate_limits.window_start
    END,
    attempts = CASE
      -- Currently blocked: do not increment (request will be rejected below)
      WHEN rate_limits.block_until IS NOT NULL AND v_now < rate_limits.block_until
        THEN rate_limits.attempts
      -- Window expired: reset counter
      WHEN rate_limits.window_start + v_window_interval <= v_now
        THEN 1
      -- Within window: increment
      ELSE rate_limits.attempts + 1
    END,
    block_until = CASE
      -- Preserve existing block
      WHEN rate_limits.block_until IS NOT NULL AND v_now < rate_limits.block_until
        THEN rate_limits.block_until
      -- Window just reset — no block
      WHEN rate_limits.window_start + v_window_interval <= v_now
        THEN NULL
      -- Threshold just exceeded — apply block
      WHEN rate_limits.attempts + 1 >= p_max_attempts
        THEN v_now + v_block_interval
      ELSE NULL
    END,
    last_updated = v_now
  RETURNING * INTO v_row;

  -- Blocked?
  IF v_row.block_until IS NOT NULL AND v_now < v_row.block_until THEN
    RETURN jsonb_build_object(
      'allowed',                   false,
      'remaining',                 0,
      'reset_at_epoch_ms',         EXTRACT(EPOCH FROM v_row.block_until)::BIGINT * 1000,
      'block_remaining_seconds',   CEIL(EXTRACT(EPOCH FROM (v_row.block_until - v_now)))::INT
    );
  END IF;

  RETURN jsonb_build_object(
    'allowed',                 true,
    'remaining',               GREATEST(0, p_max_attempts - v_row.attempts),
    'reset_at_epoch_ms',       EXTRACT(EPOCH FROM (v_row.window_start + v_window_interval))::BIGINT * 1000,
    'block_remaining_seconds', NULL
  );
END;
$$;
`;

/**
 * Default rate limits (same as Firebase equivalent).
 */
export const DEFAULT_RATE_LIMITS: Record<string, RateLimitConfig> = {
  api: {
    maxAttempts: 100,
    windowMs: 60 * 1000, // 1 minute
    blockDurationMs: 5 * 60 * 1000, // 5 minutes
  },
  create: {
    maxAttempts: 20,
    windowMs: 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
  },
  update: {
    maxAttempts: 30,
    windowMs: 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
  },
  delete: {
    maxAttempts: 10,
    windowMs: 60 * 1000,
    blockDurationMs: 10 * 60 * 1000,
  },
  read: {
    maxAttempts: 200,
    windowMs: 60 * 1000,
    blockDurationMs: 5 * 60 * 1000,
  },
};

/** Shape returned by the `rate_limit_check` PostgreSQL function. */
interface RpcResult {
  allowed: boolean;
  remaining: number;
  reset_at_epoch_ms: number;
  block_remaining_seconds: number | null;
}

/**
 * Atomically check and increment a rate limit counter using the `rate_limit_check`
 * PostgreSQL function. Requires the function to be deployed (see `RATE_LIMIT_CHECK_SQL`).
 *
 * **Fail behaviour:** FAILS CLOSED on any error — a broken rate limiter must not
 * allow unlimited access. Log the error and alert your team; do not suppress it.
 *
 * @param supabaseAdmin - Supabase admin client (service role key — never expose to clients)
 * @param key           - Rate limit key, e.g. `"create_userId"` or `"api_ip"`
 * @param config        - Rate limit configuration
 */
export async function checkRateLimitWithPostgres(
  supabaseAdmin: SupabaseClient,
  key: string,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  const now = Date.now();

  /** Fail-closed response — blocks the caller on any infrastructure error. */
  const failClosed = (): RateLimitResult => ({
    allowed: false,
    remaining: 0,
    resetAt: new Date(now + config.windowMs),
    blockRemainingSeconds: Math.ceil(config.windowMs / 1000),
  });

  try {
    const { data, error } = await supabaseAdmin.rpc('rate_limit_check', {
      p_key: key,
      p_max_attempts: config.maxAttempts,
      p_window_ms: config.windowMs,
      p_block_duration_ms: config.blockDurationMs,
    });

    if (error) {
      // G70: Distinguish missing function from network/other errors for clearer diagnostics
      const isNotFound =
        error.code === '42883' ||
        (error.message?.includes('function') &&
          error.message?.includes('does not exist'));
      if (isNotFound) {
        console.error(
          '[rateLimit] rate_limit_check function not found. ' +
            'Deploy the required SQL migration (see RATE_LIMIT_CHECK_SQL).',
          error.message
        );
      } else {
        console.error(
          '[rateLimit] rate_limit_check RPC failed (network/runtime error):',
          error.message,
          error.code
        );
      }
      return failClosed();
    }

    const result = data as RpcResult;
    return {
      allowed: result.allowed,
      remaining: result.remaining,
      resetAt: new Date(result.reset_at_epoch_ms),
      blockRemainingSeconds: result.block_remaining_seconds,
    };
  } catch (error) {
    console.error(
      '[rateLimit] Unexpected error in checkRateLimitWithPostgres:',
      error
    );
    return failClosed();
  }
}
