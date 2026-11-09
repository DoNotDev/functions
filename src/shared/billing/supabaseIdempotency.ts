// packages/functions/src/shared/billing/supabaseIdempotency.ts

/**
 * @fileoverview Postgres (Supabase) webhook idempotency store
 * @description `webhook_events` table and its RPCs. Re-exported from
 * `idempotency.ts`.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import * as v from 'valibot';

import { handleError } from '../errorHandling.js';
import {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  newOwnerToken,
} from './idempotencyContract.js';
import type {
  IdempotencyStore,
  ReservationResult,
} from './idempotencyContract.js';

/**
 * SQL required by {@link createSupabaseIdempotencyStore}: table, the
 * service_role-only RPCs `webhook_event_reserve` / `webhook_event_mark_processed`
 * / `webhook_event_release`, and a daily pg_cron cleanup (30 days). Shipped
 * verbatim as the CLI Supabase template migration `*_webhook_events.sql`.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const WEBHOOK_EVENTS_SQL = `
CREATE TABLE IF NOT EXISTS public.webhook_events (
  event_id     TEXT        PRIMARY KEY,
  status       TEXT        NOT NULL CHECK (status IN ('processing', 'processed')),
  owner_token  UUID        NOT NULL,
  reserved_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ
);

-- Only service_role accesses this table
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS idx_webhook_events_processed_at
  ON public.webhook_events (processed_at);

-- The functions below run as the caller (SECURITY INVOKER) and refuse every
-- role but service_role. EXECUTE is deliberately not revoked: on Supabase
-- Postgres 17.6.1.x a permission-denied function call by anon/authenticated
-- crashes the backend (signal 11), which restarts every connection.
CREATE OR REPLACE FUNCTION public.webhook_events_assert_service_role()
RETURNS VOID
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF current_user IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'webhook_events is reserved to service_role (current role: %)', current_user
      USING ERRCODE = 'insufficient_privilege';
  END IF;
END;
$$;

-- Atomic reservation. Returns:
--   'reserved'    the caller now owns the event under p_owner_token
--   'processed'   the event was already processed (skip, answer 2xx)
--   'in_progress' another worker holds a live lease (answer non-2xx, Stripe retries)
-- A 'processing' row older than the lease is retaken (abandoned worker).
CREATE OR REPLACE FUNCTION public.webhook_event_reserve(
  p_event_id      TEXT,
  p_owner_token   UUID,
  p_lease_seconds INT
)
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status TEXT;
BEGIN
  PERFORM public.webhook_events_assert_service_role();

  INSERT INTO public.webhook_events (event_id, status, owner_token, reserved_at)
  VALUES (p_event_id, 'processing', p_owner_token, clock_timestamp())
  ON CONFLICT (event_id) DO UPDATE
    SET owner_token = EXCLUDED.owner_token,
        reserved_at = clock_timestamp()
    WHERE webhook_events.status = 'processing'
      AND webhook_events.reserved_at
          < clock_timestamp() - make_interval(secs => p_lease_seconds);
  IF FOUND THEN
    RETURN 'reserved';
  END IF;

  SELECT status INTO v_status
    FROM public.webhook_events
   WHERE event_id = p_event_id;
  IF v_status = 'processed' THEN
    RETURN 'processed';
  END IF;
  -- Live lease, or the row was released in between: Stripe retries either way
  RETURN 'in_progress';
END;
$$;

-- Mark a reservation processed. Returns false when p_owner_token no longer owns
-- the row (lease retaken, released, or deleted). Repeating it for the same
-- owner is a no-op that returns true.
CREATE OR REPLACE FUNCTION public.webhook_event_mark_processed(
  p_event_id    TEXT,
  p_owner_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.webhook_events_assert_service_role();

  UPDATE public.webhook_events
     SET status = 'processed',
         processed_at = COALESCE(processed_at, clock_timestamp())
   WHERE event_id = p_event_id
     AND owner_token = p_owner_token;
  RETURN FOUND;
END;
$$;

-- Drop a reservation after a processing failure. Returns false when
-- p_owner_token does not own a 'processing' row (nothing is deleted).
CREATE OR REPLACE FUNCTION public.webhook_event_release(
  p_event_id    TEXT,
  p_owner_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  PERFORM public.webhook_events_assert_service_role();

  DELETE FROM public.webhook_events
   WHERE event_id = p_event_id
     AND owner_token = p_owner_token
     AND status = 'processing';
  RETURN FOUND;
END;
$$;

-- Enable pg_cron extension (if not already enabled)
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Cleanup webhook events older than 30 days (daily at 5 AM UTC).
-- Stripe retries an event for up to 3 days, so older rows are never read again.
SELECT cron.schedule(
  'cleanup-webhook-events',
  '0 5 * * *',
  $$DELETE FROM public.webhook_events WHERE COALESCE(processed_at, reserved_at) < now() - interval '30 days'$$
);
`;

const ReserveResultSchema = v.picklist(['reserved', 'processed', 'in_progress']);
const OwnedResultSchema = v.boolean();

/**
 * Postgres-backed store (Supabase). Requires {@link WEBHOOK_EVENTS_SQL}.
 *
 * @param supabaseAdmin - Supabase client created with the service role key
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function createSupabaseIdempotencyStore(
  supabaseAdmin: SupabaseClient
): IdempotencyStore {
  const call = async <T>(
    fn: string,
    args: Record<string, unknown>,
    schema: v.GenericSchema<unknown, T>
  ): Promise<T> => {
    const { data, error } = await supabaseAdmin.rpc(fn, args);
    if (error) throw handleError(error);
    const result = v.safeParse(schema, data);
    if (!result.success) {
      throw handleError(
        new Error(`${fn} returned an unexpected result: ${JSON.stringify(data)}`)
      );
    }
    return result.output;
  };

  return {
    async reserve(eventId): Promise<ReservationResult> {
      const ownerToken = newOwnerToken();
      const state = await call(
        'webhook_event_reserve',
        {
          p_event_id: eventId,
          p_owner_token: ownerToken,
          p_lease_seconds: RESERVATION_LEASE_MS / 1000,
        },
        ReserveResultSchema
      );
      return state === 'reserved' ? { state, ownerToken } : { state };
    },
    async markProcessed(eventId, ownerToken) {
      const owned = await call(
        'webhook_event_mark_processed',
        { p_event_id: eventId, p_owner_token: ownerToken },
        OwnedResultSchema
      );
      if (!owned) throw new ReservationLostError(eventId);
    },
    async release(eventId, ownerToken) {
      return call(
        'webhook_event_release',
        { p_event_id: eventId, p_owner_token: ownerToken },
        OwnedResultSchema
      );
    },
  };
}
