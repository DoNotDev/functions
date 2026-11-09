// packages/functions/src/shared/billing/firestoreIdempotency.ts

/**
 * @fileoverview Firestore webhook idempotency store
 * @description `webhook_idempotency` collection, transactional reservations.
 * Used by the Firebase and Vercel (Firestore backend) webhook entry points.
 * Re-exported from `idempotency.ts`. Loads `@donotdev/firebase/server` on
 * first use only.
 *
 * @version 0.2.1
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { handleError } from '../errorHandling.js';
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

/** Firestore collection holding webhook event reservations (name kept from 0.1.x). */
const FIRESTORE_COLLECTION = 'webhook_idempotency';

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
