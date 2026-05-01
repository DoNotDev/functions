// packages/functions/src/shared/billing/idempotency.ts

/**
 * @fileoverview Adaptive Idempotency for Billing Webhooks
 * @description Auto-detects Firestore, gracefully degrades to in-memory
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { handleError } from '../errorHandling.js';
import { isFirestoreConfigured } from '../utils/detectFirestore.js';

/**
 * Idempotency store interface
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface IdempotencyStore {
  isProcessed(eventId: string): Promise<boolean>;
  markProcessed(eventId: string): Promise<void>;
  /** Atomic check-and-reserve: returns true if already processed, false if reserved for processing */
  checkAndReserve(eventId: string): Promise<boolean>;
}

/**
 * In-memory idempotency (fallback)
 */
class InMemoryIdempotency implements IdempotencyStore {
  private store = new Set<string>();
  private warned = false;

  async isProcessed(eventId: string): Promise<boolean> {
    if (!this.warned) {
      // Use handleError for consistent error handling, but don't throw for warnings
      console.warn(
        '⚠️  [Idempotency] Using in-memory storage (not production-ready for scale)\n' +
          '    Enable Firestore for production: https://console.firebase.google.com\n' +
          '    Good for: Single instance, < 1K webhooks/month\n' +
          '    Upgrade when: Multiple instances, > 1K webhooks/month'
      );
      this.warned = true;
    }
    return this.store.has(eventId);
  }

  async markProcessed(eventId: string): Promise<void> {
    this.store.add(eventId);

    // G58: FIFO cleanup — delete the oldest (first-inserted) entry via iterator
    if (this.store.size > 1000) {
      const oldest = this.store.values().next().value;
      if (oldest) this.store.delete(oldest);
    }
  }

  /**
   * @limitation Not truly atomic for concurrent async operations within the same event loop tick.
   * Two webhook retries arriving simultaneously could both pass the check.
   * For production billing, use the Firestore/Supabase implementations which provide true atomicity.
   */
  async checkAndReserve(eventId: string): Promise<boolean> {
    if (this.store.has(eventId)) return true;
    this.store.add(eventId);
    return false;
  }
}

/**
 * Firestore idempotency (production)
 */
class FirestoreIdempotency implements IdempotencyStore {
  private db!: FirebaseFirestore.Firestore;
  private collection = 'webhook_idempotency';
  private initialized = false;

  private async init() {
    if (this.initialized) return;

    const { getFirebaseAdminFirestore } =
      await import('@donotdev/firebase/server');
    this.db = getFirebaseAdminFirestore();
    this.initialized = true;
  }

  async isProcessed(eventId: string): Promise<boolean> {
    await this.init();

    try {
      const doc = await this.db.collection(this.collection).doc(eventId).get();

      if (!doc.exists) return false;

      const data = doc.data();
      if (!data) return false;

      // Check expiration (30 days)
      const expiresAt = data.expiresAt || 0;
      if (expiresAt < Date.now()) {
        await doc.ref.delete(); // Clean up expired
        return false;
      }

      return true;
    } catch (error) {
      throw handleError(error);
    }
  }

  async markProcessed(eventId: string): Promise<void> {
    await this.init();

    try {
      // Use atomic check-and-set to prevent race conditions
      await this.db.runTransaction(async (transaction) => {
        const docRef = this.db.collection(this.collection).doc(eventId);
        const doc = await transaction.get(docRef);

        if (doc.exists) {
          // Already processed, no need to set again
          return;
        }

        // Atomically set the document
        transaction.set(docRef, {
          eventId,
          processedAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
        });
      });
    } catch (error) {
      throw handleError(error);
    }
  }

  async checkAndReserve(eventId: string): Promise<boolean> {
    await this.init();

    try {
      let alreadyProcessed = false;
      await this.db.runTransaction(async (transaction) => {
        const docRef = this.db.collection(this.collection).doc(eventId);
        const doc = await transaction.get(docRef);

        if (doc.exists) {
          const data = doc.data();
          const expiresAt = data?.expiresAt || 0;
          if (expiresAt >= Date.now()) {
            alreadyProcessed = true;
            return;
          }
        }

        // Atomically reserve the event
        transaction.set(docRef, {
          eventId,
          processedAt: Date.now(),
          expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000, // 30 days
        });
      });
      return alreadyProcessed;
    } catch (error) {
      throw handleError(error);
    }
  }
}

/**
 * Create idempotency store with auto-detection
 *
 * Checks for Firestore availability:
 * 1. Running in Firebase Functions environment (auto-configured)
 * 2. Manual Firebase Admin SDK credentials in .env
 *
 * Falls back to in-memory if Firestore not available
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
let cachedStore: IdempotencyStore | null = null;

export function createIdempotencyStore(): IdempotencyStore {
  // Return cached instance (singleton per function instance)
  if (cachedStore) return cachedStore;

  if (isFirestoreConfigured()) {
    console.log('✅ [Idempotency] Using Firestore (production-ready)');
    cachedStore = new FirestoreIdempotency();
  } else {
    console.warn('⚠️  [Idempotency] Firestore not configured, using in-memory');
    cachedStore = new InMemoryIdempotency();
  }

  return cachedStore;
}

/**
 * Reset cached store (for testing only)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function resetIdempotencyStore() {
  cachedStore = null;
}
