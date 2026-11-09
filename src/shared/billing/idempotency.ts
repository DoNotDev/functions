// packages/functions/src/shared/billing/idempotency.ts

/**
 * @fileoverview Webhook idempotency stores
 * @description Durable, atomic event reservation for Stripe webhooks. Every
 * webhook entry point passes the store that matches its backend: Firestore
 * (Firebase) or Postgres (Supabase, see `supabaseIdempotency.ts`). There is no
 * implicit fallback.
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

import * as v from 'valibot';

import { handleError } from '../errorHandling.js';
import { isFirestoreConfigured } from '../utils/detectFirestore.js';
import {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  WEBHOOK_EVENT_RETENTION_MS,
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

/** Firestore collection holding webhook event reservations (name kept from 0.1.x). */
const FIRESTORE_COLLECTION = 'webhook_idempotency';

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
// Firestore
// =============================================================================

/** Millisecond reading of an `expiresAt` value: Timestamp (0.2.x) or number (0.1.x). */
const ExpiresAtSchema = v.union([
  v.number(),
  v.pipe(
    v.custom<{ toMillis(): number }>(
      (value) =>
        typeof value === 'object' &&
        value !== null &&
        typeof (value as { toMillis?: unknown }).toMillis === 'function',
      'expiresAt must be a Firestore Timestamp or a number'
    ),
    v.transform((timestamp) => timestamp.toMillis())
  ),
]);

/**
 * Stored reservation document. 0.1.x documents carry no `status` and mean processed.
 */
const FirestoreEventDocSchema = v.object({
  status: v.optional(v.picklist(['processing', 'processed'])),
  ownerToken: v.optional(v.string()),
  reservedAt: v.optional(v.number()),
  expiresAt: v.optional(ExpiresAtSchema),
});

function parseEventDoc(eventId: string, data: unknown) {
  const result = v.safeParse(FirestoreEventDocSchema, data);
  if (!result.success) {
    throw new Error(
      `Malformed ${FIRESTORE_COLLECTION}/${eventId}: ${result.issues.map((issue) => issue.message).join('; ')}`
    );
  }
  return result.output;
}

/**
 * Firestore-backed store (transactions). Collection: `webhook_idempotency`.
 *
 * `expiresAt` is a Firestore Timestamp {@link WEBHOOK_EVENT_RETENTION_MS} after
 * the last write: enable a TTL policy on `webhook_idempotency.expiresAt` so
 * Firestore deletes old documents.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function createFirestoreIdempotencyStore(): LegacyIdempotencyStore {
  let firebase: typeof import('@donotdev/firebase/server') | null = null;
  const load = async () => {
    if (!firebase) firebase = await import('@donotdev/firebase/server');
    const firestore = firebase.getFirebaseAdminFirestore();
    return {
      firestore,
      Timestamp: firebase.Timestamp,
      refOf: (eventId: string) =>
        firestore.collection(FIRESTORE_COLLECTION).doc(eventId),
    };
  };

  const reserve = async (eventId: string): Promise<ReservationResult> => {
    const { firestore, Timestamp, refOf } = await load();
    const ref = refOf(eventId);
    try {
      return await firestore.runTransaction(async (tx) => {
        const snapshot = await tx.get(ref);
        const now = Date.now();
        if (snapshot.exists) {
          const data = parseEventDoc(eventId, snapshot.data());
          if (data.status === 'processing') {
            if (now - (data.reservedAt ?? 0) < RESERVATION_LEASE_MS) {
              return { state: 'in_progress' } as const;
            }
          } else if ((data.expiresAt ?? 0) >= now) {
            return { state: 'processed' } as const;
          }
        }
        const ownerToken = newOwnerToken();
        tx.set(ref, {
          eventId,
          status: 'processing',
          ownerToken,
          reservedAt: now,
          expiresAt: Timestamp.fromMillis(now + WEBHOOK_EVENT_RETENTION_MS),
        });
        return { state: 'reserved', ownerToken } as const;
      });
    } catch (error) {
      throw handleError(error);
    }
  };

  return {
    reserve,
    async checkAndReserve(eventId) {
      return (await reserve(eventId)).state !== 'reserved';
    },
    async markProcessed(eventId, ownerToken) {
      const { firestore, Timestamp, refOf } = await load();
      const ref = refOf(eventId);
      const now = Date.now();
      const processed = {
        eventId,
        status: 'processed',
        processedAt: now,
        expiresAt: Timestamp.fromMillis(now + WEBHOOK_EVENT_RETENTION_MS),
      };
      try {
        if (ownerToken === undefined) {
          // 0.1.x call: unconditional write
          await ref.set(processed);
          return;
        }
        await firestore.runTransaction(async (tx) => {
          const snapshot = await tx.get(ref);
          const data = snapshot.exists
            ? parseEventDoc(eventId, snapshot.data())
            : null;
          if (data?.ownerToken !== ownerToken) {
            throw new ReservationLostError(eventId);
          }
          tx.set(ref, { ...processed, ownerToken });
        });
      } catch (error) {
        if (error instanceof ReservationLostError) throw error;
        throw handleError(error);
      }
    },
    async release(eventId, ownerToken) {
      const { firestore, refOf } = await load();
      const ref = refOf(eventId);
      try {
        return await firestore.runTransaction(async (tx) => {
          const snapshot = await tx.get(ref);
          if (!snapshot.exists) return false;
          const data = parseEventDoc(eventId, snapshot.data());
          if (data.status !== 'processing' || data.ownerToken !== ownerToken) {
            return false;
          }
          tx.delete(ref);
          return true;
        });
      } catch (error) {
        throw handleError(error);
      }
    },
    async isProcessed(eventId) {
      const { refOf } = await load();
      try {
        const snapshot = await refOf(eventId).get();
        if (!snapshot.exists) return false;
        const data = parseEventDoc(eventId, snapshot.data());
        return data.status !== 'processing' && (data.expiresAt ?? 0) >= Date.now();
      } catch (error) {
        throw handleError(error);
      }
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
