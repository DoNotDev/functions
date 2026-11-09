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

import { isFirestoreConfigured } from '../utils/detectFirestore.js';
import { createFirestoreIdempotencyStore } from './firestoreIdempotency.js';
import {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  newOwnerToken,
} from './idempotencyContract.js';
import type {
  LegacyIdempotencyStore,
  ReservationResult,
} from './idempotencyContract.js';

export {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  WEBHOOK_EVENT_RETENTION_MS,
} from './idempotencyContract.js';
export type {
  IdempotencyStore,
  LegacyIdempotencyStore,
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
export function createInMemoryIdempotencyStore(): LegacyIdempotencyStore {
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
    async checkAndReserve(eventId) {
      return (await reserve(eventId)).state !== 'reserved';
    },
    async markProcessed(eventId, ownerToken) {
      const entry = events.get(eventId);
      if (ownerToken !== undefined && entry?.ownerToken !== ownerToken) {
        throw new ReservationLostError(eventId);
      }
      events.set(eventId, {
        status: 'processed',
        ownerToken: ownerToken ?? entry?.ownerToken ?? newOwnerToken(),
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
    async isProcessed(eventId) {
      return events.get(eventId)?.status === 'processed';
    },
  };
}

// =============================================================================
// 0.1.x auto-detection (deprecated)
// =============================================================================

let cachedStore: LegacyIdempotencyStore | null = null;

/**
 * 0.1.x store auto-detection: Firestore when configured, else in-memory.
 *
 * @deprecated In-memory is not durable across instances. Pass an explicit store:
 * {@link createFirestoreIdempotencyStore} or `createSupabaseIdempotencyStore`.
 * Framework webhook entry points already do.
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createIdempotencyStore(): LegacyIdempotencyStore {
  if (cachedStore) return cachedStore;
  if (isFirestoreConfigured()) {
    cachedStore = createFirestoreIdempotencyStore();
  } else {
    console.warn(
      '[Idempotency] Firestore not configured, using in-memory (not durable). Pass an explicit store.'
    );
    cachedStore = createInMemoryIdempotencyStore();
  }
  return cachedStore;
}

/**
 * Reset the store cached by {@link createIdempotencyStore} (tests).
 *
 * @deprecated See {@link createIdempotencyStore}.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function resetIdempotencyStore() {
  cachedStore = null;
}

export {
  WEBHOOK_EVENTS_SQL,
  createSupabaseIdempotencyStore,
} from './supabaseIdempotency.js';
