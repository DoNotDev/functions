// packages/functions/src/shared/billing/__tests__/firestoreIdempotency.emulator.test.ts

/**
 * @fileoverview Firestore idempotency store against the Firestore emulator
 * @description Runs only when FIRESTORE_EMULATOR_HOST is set, e.g.
 * `bunx firebase-tools emulators:exec --only firestore --project demo-dndev
 *  "bunx vitest run src/shared/billing/__tests__/firestoreIdempotency.emulator.test.ts"`.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import { describe, expect, it } from 'vitest';

const enabled = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

describe.skipIf(!enabled)('firestore idempotency store (emulator)', () => {
  const load = async () => {
    const { createFirestoreIdempotencyStore, ReservationLostError } =
      await import('../idempotency.js');
    const { getFirebaseAdminFirestore, Timestamp } =
      await import('@donotdev/firebase/server');
    return {
      store: createFirestoreIdempotencyStore(),
      ReservationLostError,
      Timestamp,
      collection: getFirebaseAdminFirestore().collection('webhook_idempotency'),
    };
  };
  const id = (name: string) => `evt_emu_${name}_${crypto.randomUUID()}`;

  it('reserve → in_progress → markProcessed → processed, expiresAt is a Timestamp', async () => {
    const { store, Timestamp, collection } = await load();
    const eventId = id('flow');
    const first = await store.reserve(eventId);
    expect(first.state).toBe('reserved');
    if (first.state !== 'reserved') return;
    expect(await store.reserve(eventId)).toEqual({ state: 'in_progress' });

    const reserved = (await collection.doc(eventId).get()).data()!;
    expect(reserved.expiresAt).toBeInstanceOf(Timestamp);
    expect(reserved.ownerToken).toBe(first.ownerToken);

    await store.markProcessed(eventId, first.ownerToken);
    expect(await store.reserve(eventId)).toEqual({ state: 'processed' });
    const processed = (await collection.doc(eventId).get()).data()!;
    expect(processed.status).toBe('processed');
    expect(processed.expiresAt).toBeInstanceOf(Timestamp);
    const days =
      (processed.expiresAt.toMillis() - processed.processedAt) / 86_400_000;
    expect(days).toBe(30);
  });

  it('concurrent deliveries: exactly one reserves', async () => {
    const { store } = await load();
    const eventId = id('race');
    const results = await Promise.all(
      Array.from({ length: 8 }, () => store.reserve(eventId))
    );
    expect(results.filter((r) => r.state === 'reserved')).toHaveLength(1);
    expect(results.filter((r) => r.state === 'in_progress')).toHaveLength(7);
  });

  it('owner token: foreign release is a no-op, foreign markProcessed fails loud', async () => {
    const { store, ReservationLostError } = await load();
    const eventId = id('owner');
    const mine = await store.reserve(eventId);
    if (mine.state !== 'reserved') throw new Error('expected reserved');
    expect(await store.release(eventId, crypto.randomUUID())).toBe(false);
    await expect(
      store.markProcessed(eventId, crypto.randomUUID())
    ).rejects.toBeInstanceOf(ReservationLostError);
    expect(await store.release(eventId, mine.ownerToken)).toBe(true);
    expect((await store.reserve(eventId)).state).toBe('reserved');
  });

  it('lease takeover: an expired reservation is retaken and the stale owner is locked out', async () => {
    const { store, ReservationLostError, collection } = await load();
    const eventId = id('lease');
    const stale = await store.reserve(eventId);
    if (stale.state !== 'reserved') throw new Error('expected reserved');
    await collection.doc(eventId).update({ reservedAt: Date.now() - 71 * 60_000 });

    const fresh = await store.reserve(eventId);
    expect(fresh.state).toBe('reserved');
    await expect(
      store.markProcessed(eventId, stale.ownerToken)
    ).rejects.toBeInstanceOf(ReservationLostError);
    expect(await store.release(eventId, stale.ownerToken)).toBe(false);
  });
});
