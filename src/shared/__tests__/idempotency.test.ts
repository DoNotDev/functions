// packages/functions/src/shared/__tests__/idempotency.test.ts

/**
 * @fileoverview Tests for webhook idempotency stores
 * @description Three-state reservation and owner token for the in-memory,
 * Firestore (mocked Firestore) and Supabase (mocked RPC) stores; the shipped
 * migration must equal WEBHOOK_EVENTS_SQL.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

vi.mock('../utils/detectFirestore.js', () => ({
  isFirestoreConfigured: vi.fn(() => false),
}));

/** Minimal Firestore Timestamp double (only what the store uses). */
class FakeTimestamp {
  constructor(private readonly millis: number) {}
  static fromMillis(millis: number) {
    return new FakeTimestamp(millis);
  }
  toMillis() {
    return this.millis;
  }
}

/** In-memory Firestore double: docs map + serial transactions. */
const docs = new Map<string, Record<string, unknown>>();
function makeRef(id: string) {
  return {
    id,
    async get() {
      const data = docs.get(id);
      return { exists: data !== undefined, data: () => data };
    },
    async set(data: Record<string, unknown>) {
      docs.set(id, data);
    },
  };
}
const fakeFirestore = {
  collection: vi.fn(() => ({ doc: (id: string) => makeRef(id) })),
  async runTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    const tx = {
      get: (ref: ReturnType<typeof makeRef>) => ref.get(),
      set: (ref: ReturnType<typeof makeRef>, data: Record<string, unknown>) =>
        docs.set(ref.id, data),
      delete: (ref: ReturnType<typeof makeRef>) => docs.delete(ref.id),
    };
    return fn(tx);
  },
};

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: () => fakeFirestore,
  Timestamp: FakeTimestamp,
}));

import {
  RESERVATION_LEASE_MS,
  ReservationLostError,
  WEBHOOK_EVENT_RETENTION_MS,
  WEBHOOK_EVENTS_SQL,
  createFirestoreIdempotencyStore,
  createIdempotencyStore,
  createInMemoryIdempotencyStore,
  createSupabaseIdempotencyStore,
  resetIdempotencyStore,
} from '../billing/idempotency';
import type { IdempotencyStore } from '../billing/idempotency';

async function reservedToken(store: IdempotencyStore, eventId: string) {
  const result = await store.reserve(eventId);
  if (result.state !== 'reserved') throw new Error(`expected reserved, got ${result.state}`);
  return result.ownerToken;
}

/** Contract shared by the in-memory and Firestore stores. */
function storeContract(name: string, make: () => IdempotencyStore) {
  describe(`${name} store contract`, () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reserves a new event with an owner token', async () => {
      const result = await make().reserve('evt_1');
      expect(result.state).toBe('reserved');
      expect(result.state === 'reserved' && result.ownerToken).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('answers in_progress under a live lease', async () => {
      const store = make();
      await store.reserve('evt_2');
      expect(await store.reserve('evt_2')).toEqual({ state: 'in_progress' });
    });

    it('answers processed after markProcessed by the owner (repeatable)', async () => {
      const store = make();
      const token = await reservedToken(store, 'evt_3');
      await store.markProcessed('evt_3', token);
      await store.markProcessed('evt_3', token);
      expect(await store.reserve('evt_3')).toEqual({ state: 'processed' });
    });

    it('re-reserves a released event (retry after failure)', async () => {
      const store = make();
      const token = await reservedToken(store, 'evt_4');
      expect(await store.release('evt_4', token)).toBe(true);
      expect((await store.reserve('evt_4')).state).toBe('reserved');
    });

    it('release does not drop a processed event', async () => {
      const store = make();
      const token = await reservedToken(store, 'evt_5');
      await store.markProcessed('evt_5', token);
      expect(await store.release('evt_5', token)).toBe(false);
      expect(await store.reserve('evt_5')).toEqual({ state: 'processed' });
    });

    it('retakes an abandoned reservation after the lease; the stale owner can no longer change it', async () => {
      const store = make();
      const start = Date.now();
      const now = vi.spyOn(Date, 'now').mockReturnValue(start);
      const stale = await reservedToken(store, 'evt_6');
      now.mockReturnValue(start + RESERVATION_LEASE_MS + 1);
      const fresh = await reservedToken(store, 'evt_6');
      expect(fresh).not.toBe(stale);

      expect(await store.release('evt_6', stale)).toBe(false);
      await expect(store.markProcessed('evt_6', stale)).rejects.toBeInstanceOf(
        ReservationLostError
      );
      expect(await store.reserve('evt_6')).toEqual({ state: 'in_progress' });
      await store.markProcessed('evt_6', fresh);
      expect(await store.reserve('evt_6')).toEqual({ state: 'processed' });
    });

    it('a foreign token cannot release or mark a live reservation', async () => {
      const store = make();
      await reservedToken(store, 'evt_7');
      expect(await store.release('evt_7', 'not-the-owner')).toBe(false);
      await expect(store.markProcessed('evt_7', 'not-the-owner')).rejects.toBeInstanceOf(
        ReservationLostError
      );
      expect(await store.reserve('evt_7')).toEqual({ state: 'in_progress' });
    });

    it('markProcessed without any reservation fails loud', async () => {
      await expect(make().markProcessed('evt_none', 'tok')).rejects.toBeInstanceOf(
        ReservationLostError
      );
    });

    it('keeps events independent', async () => {
      const store = make();
      const token = await reservedToken(store, 'evt_a');
      await store.markProcessed('evt_a', token);
      expect((await store.reserve('evt_b')).state).toBe('reserved');
    });
  });
}

storeContract('in-memory', () => createInMemoryIdempotencyStore());

beforeEach(() => {
  docs.clear();
});
storeContract('firestore (mocked)', () => createFirestoreIdempotencyStore());

describe('firestore store: documents', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('writes expiresAt as a Firestore Timestamp 30 days out (TTL-eligible)', async () => {
    const start = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockReturnValue(start);
    const store = createFirestoreIdempotencyStore();
    const token = await reservedToken(store, 'evt_ttl');
    const reserved = docs.get('evt_ttl')!;
    expect(reserved.expiresAt).toBeInstanceOf(FakeTimestamp);
    expect((reserved.expiresAt as FakeTimestamp).toMillis()).toBe(
      start + WEBHOOK_EVENT_RETENTION_MS
    );
    expect(reserved).toMatchObject({ status: 'processing', ownerToken: token, reservedAt: start });

    await store.markProcessed('evt_ttl', token);
    const processed = docs.get('evt_ttl')!;
    expect(processed).toMatchObject({ status: 'processed', ownerToken: token });
    expect(processed.expiresAt).toBeInstanceOf(FakeTimestamp);
    expect(WEBHOOK_EVENT_RETENTION_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('treats a 0.1.x document (no status, numeric expiresAt) as processed until it expires', async () => {
    const store = createFirestoreIdempotencyStore();
    docs.set('evt_old', { eventId: 'evt_old', processedAt: 1, expiresAt: Date.now() + 60_000 });
    expect(await store.reserve('evt_old')).toEqual({ state: 'processed' });
    docs.set('evt_old2', { eventId: 'evt_old2', processedAt: 1, expiresAt: Date.now() - 1 });
    expect((await store.reserve('evt_old2')).state).toBe('reserved');
  });

  it('fails loud on a malformed document', async () => {
    docs.set('evt_bad', { status: 'weird' });
    await expect(createFirestoreIdempotencyStore().reserve('evt_bad')).rejects.toThrow();
  });
});

describe('supabase idempotency store', () => {
  function makeSupabase(data: unknown, error: unknown = null) {
    return { rpc: vi.fn(async () => ({ data, error })) };
  }

  it('reserve calls webhook_event_reserve with a fresh owner token and the lease', async () => {
    const client = makeSupabase('reserved');
    const result = await createSupabaseIdempotencyStore(client as any).reserve('evt_s1');
    expect(result.state).toBe('reserved');
    const [fn, args] = (client.rpc.mock.calls as any[])[0];
    expect(fn).toBe('webhook_event_reserve');
    expect(args).toEqual({
      p_event_id: 'evt_s1',
      p_owner_token: result.state === 'reserved' ? result.ownerToken : null,
      p_lease_seconds: RESERVATION_LEASE_MS / 1000,
    });
  });

  it.each(['processed', 'in_progress'] as const)('maps %s', async (state) => {
    const store = createSupabaseIdempotencyStore(makeSupabase(state) as any);
    expect(await store.reserve('evt_s2')).toEqual({ state });
  });

  it('throws on RPC error (fail closed)', async () => {
    const store = createSupabaseIdempotencyStore(
      makeSupabase(null, new Error('function webhook_event_reserve does not exist')) as any
    );
    await expect(store.reserve('evt_s3')).rejects.toThrow();
  });

  it('throws on an unexpected RPC result', async () => {
    const store = createSupabaseIdempotencyStore(makeSupabase(true) as any);
    await expect(store.reserve('evt_s3b')).rejects.toThrow();
  });

  it('markProcessed passes the owner token and succeeds when the row is owned', async () => {
    const client = makeSupabase(true);
    await createSupabaseIdempotencyStore(client as any).markProcessed('evt_s4', 'tok');
    expect(client.rpc).toHaveBeenCalledWith('webhook_event_mark_processed', {
      p_event_id: 'evt_s4',
      p_owner_token: 'tok',
    });
  });

  it('markProcessed fails loud when 0 rows are owned', async () => {
    const store = createSupabaseIdempotencyStore(makeSupabase(false) as any);
    await expect(store.markProcessed('evt_s5', 'tok')).rejects.toBeInstanceOf(
      ReservationLostError
    );
  });

  it('release returns whether the owner released', async () => {
    const client = makeSupabase(false);
    expect(await createSupabaseIdempotencyStore(client as any).release('evt_s6', 'tok')).toBe(
      false
    );
    expect(client.rpc).toHaveBeenCalledWith('webhook_event_release', {
      p_event_id: 'evt_s6',
      p_owner_token: 'tok',
    });
  });

  it('the CLI template migration ships WEBHOOK_EVENTS_SQL verbatim', () => {
    const migration = readFileSync(
      fileURLToPath(
        new URL(
          '../../../../cli/templates/functions-supabase/supabase/migrations/20250101000005_webhook_events.sql',
          import.meta.url
        )
      ),
      'utf8'
    );
    const body = migration.slice(migration.indexOf('\n\n') + 2);
    expect(WEBHOOK_EVENTS_SQL.trim()).toBe(body.trim());
    expect(body).not.toContain('REVOKE');
    expect(body).toContain("cron.schedule(\n  'cleanup-webhook-events'");
  });
});

describe('0.1.x API (deprecated)', () => {
  afterEach(() => {
    resetIdempotencyStore();
    vi.restoreAllMocks();
  });

  it('auto-detects in-memory without Firestore and caches the instance', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createIdempotencyStore();
    expect(createIdempotencyStore()).toBe(store);
  });

  it('keeps checkAndReserve / isProcessed / tokenless markProcessed working', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const store = createIdempotencyStore();
    expect(await store.checkAndReserve('evt_l1')).toBe(false);
    expect(await store.checkAndReserve('evt_l1')).toBe(true);
    expect(await store.isProcessed('evt_l1')).toBe(false);
    await store.markProcessed('evt_l1');
    expect(await store.isProcessed('evt_l1')).toBe(true);
  });

  it('firestore: tokenless markProcessed writes unconditionally', async () => {
    const store = createFirestoreIdempotencyStore();
    await store.markProcessed('evt_l2');
    expect(await store.isProcessed('evt_l2')).toBe(true);
    expect(await store.checkAndReserve('evt_l2')).toBe(true);
  });
});
