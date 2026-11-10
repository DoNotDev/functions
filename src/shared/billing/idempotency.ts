// packages/functions/src/shared/billing/idempotency.ts

/**
 * @fileoverview Webhook idempotency stores
 * @description Durable, atomic event reservation for Stripe webhooks. Every
 * webhook entry point passes the store that matches its backend: Firestore
 * (Firebase, Vercel: `firestoreIdempotency.ts`) or Postgres (Supabase:
 * `supabaseIdempotency.ts`). There is no implicit fallback. This module
 * aggregates the stores; backend entry points import their own store file.
 *
 * Lifecycle per event: `reserve` → process → `markProcessed(ownerToken)`, or
 * `release(ownerToken)` when processing failed (so the provider's retry is
 * processed). Only the owner of a reservation may change it. A reservation
 * whose worker died is retaken after {@link RESERVATION_LEASE_MS}.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  newOwnerToken,
} from './idempotencyContract.js';
import type {
  IdempotencyStore,
  ReservationResult,
} from './idempotencyContract.js';

export {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  WEBHOOK_EVENT_RETENTION_MS,
} from './idempotencyContract.js';
export type {
  IdempotencyStore,
  ReservationResult,
} from './idempotencyContract.js';
export { createFirestoreIdempotencyStore } from './firestoreIdempotency.js';

// =============================================================================
// In-memory (tests only)
// =============================================================================

/**
 * In-memory store. Single process only: for tests, never for a deployed webhook.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function createInMemoryIdempotencyStore(): IdempotencyStore {
  const events = new Map<
    string,
    { status: 'processing' | 'processed'; ownerToken: string; at: number }
  >();
  const reserve = async (eventId: string): Promise<ReservationResult> => {
    const entry = events.get(eventId);
    const now = Date.now();
    if (entry?.status === 'processed') return { state: 'processed' };
    if (entry && now - entry.at < RESERVATION_LEASE_MS) {
      return { state: 'in_progress' };
    }
    const ownerToken = newOwnerToken();
    events.set(eventId, { status: 'processing', ownerToken, at: now });
    return { state: 'reserved', ownerToken };
  };
  return {
    reserve,
    async markProcessed(eventId, ownerToken) {
      const entry = events.get(eventId);
      if (entry?.ownerToken !== ownerToken) {
        throw new ReservationLostError(eventId);
      }
      events.set(eventId, {
        status: 'processed',
        ownerToken,
        at: Date.now(),
      });
    },
    async release(eventId, ownerToken) {
      const entry = events.get(eventId);
      if (entry?.status !== 'processing' || entry.ownerToken !== ownerToken) {
        return false;
      }
      events.delete(eventId);
      return true;
    },
  };
}

export {
  WEBHOOK_EVENTS_SQL,
  createSupabaseIdempotencyStore,
} from './supabaseIdempotency.js';
