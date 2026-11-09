// packages/functions/src/shared/billing/idempotencyContract.ts

/**
 * @fileoverview Webhook idempotency contract
 * @description Store interface, reservation result, lease and retention shared
 * by every idempotency store (in-memory, Firestore, Postgres).
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

/**
 * Outcome of {@link IdempotencyStore.reserve}.
 * - `reserved`: the caller owns the event and must process it, then call
 *   `markProcessed` or `release` with `ownerToken`
 * - `processed`: already processed, skip (answer 2xx)
 * - `in_progress`: another delivery holds a live lease (answer non-2xx so the
 *   provider retries later, when that worker finished or its lease expired)
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export type ReservationResult =
  | { state: 'reserved'; ownerToken: string }
  | { state: 'processed' }
  | { state: 'in_progress' };

/**
 * Idempotency store interface
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface IdempotencyStore {
  /** Atomically reserve an event for processing. */
  reserve(eventId: string): Promise<ReservationResult>;
  /**
   * Mark a reservation processed. Repeating it for the same owner succeeds.
   * @throws {ReservationLostError} When `ownerToken` no longer owns the event
   */
  markProcessed(eventId: string, ownerToken: string): Promise<void>;
  /**
   * Drop a reservation after a processing failure.
   * @returns `false` when `ownerToken` does not own a pending reservation (nothing changed)
   */
  release(eventId: string, ownerToken: string): Promise<boolean>;
}

/**
 * Store with the 0.1.x accessors.
 *
 * @deprecated Use {@link IdempotencyStore}: `reserve` returns three states and
 * an owner token; `checkAndReserve` and `isProcessed` do not.
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export interface LegacyIdempotencyStore extends IdempotencyStore {
  /** 0.1.x: `true` when the event must be skipped (processed or live lease). */
  checkAndReserve(eventId: string): Promise<boolean>;
  /** Whether the event was processed (non-atomic read). */
  isProcessed(eventId: string): Promise<boolean>;
  /**
   * Mark processed. Without `ownerToken` (0.1.x call) the write is unconditional.
   * @throws {ReservationLostError} When `ownerToken` is given and no longer owns the event
   */
  markProcessed(eventId: string, ownerToken?: string): Promise<void>;
}

/**
 * Thrown by `markProcessed` when the caller no longer owns the reservation:
 * its lease expired and another delivery retook the event, or the row is gone.
 * Retrying cannot succeed.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export class ReservationLostError extends Error {
  /** Event whose reservation was lost. */
  readonly eventId: string;

  constructor(eventId: string) {
    super(
      `Reservation of webhook event ${eventId} is no longer held by this worker (lease retaken or row removed)`
    );
    this.name = 'ReservationLostError';
    this.eventId = eventId;
  }
}

/**
 * How long a reservation blocks other deliveries of the same event before it
 * is considered abandoned (worker crashed or timed out) and can be retaken.
 *
 * Must exceed the longest request timeout a webhook handler can run under, so
 * a live worker is never overtaken. Official maximums (checked 2026-11-04):
 * - Firebase Functions gen2 HTTP: 60 min
 *   (https://firebase.google.com/docs/functions/quotas#time_limits)
 * - Vercel Functions: 800 s, 1800 s with extended max duration
 *   (https://vercel.com/docs/functions/configuring-functions/duration)
 * - Supabase Edge Functions: 400 s wall clock on paid plans
 *   (https://supabase.com/docs/guides/functions/limits)
 * 70 min = the 60 min maximum + 10 min margin. Stripe retries for up to 3 days.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const RESERVATION_LEASE_MS = 70 * 60 * 1000;

/**
 * How long reservations and processed events are kept before a TTL policy
 * (Firestore `expiresAt`) or the pg_cron cleanup (Postgres) deletes them.
 * Stripe retries for days, not weeks.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const WEBHOOK_EVENT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * New reservation owner token (random UUID). Internal to the stores.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function newOwnerToken(): string {
  return crypto.randomUUID();
}
