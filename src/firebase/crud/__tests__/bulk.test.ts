// packages/functions/src/firebase/crud/__tests__/bulk.test.ts

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock firebase-functions logger before the module under test imports it.
vi.mock('firebase-functions/v2', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    log: vi.fn(),
  },
}));

// Firestore Admin mock — minted ids, a transaction stub that records every
// tx.set / tx.update / tx.delete call in input order, and a handle to force
// the transaction body to throw (simulates ROLLBACK).
interface MockRef {
  id: string;
}

const txCalls: Array<
  | { op: 'set'; ref: MockRef; data: any }
  | { op: 'update'; ref: MockRef; data: any }
  | { op: 'delete'; ref: MockRef }
> = [];

let mintedIdCounter = 0;
let runTransactionInvocations = 0;
let simulateRollback: Error | null = null;

const mockDocRef = (id?: string): MockRef => {
  if (id) return { id };
  mintedIdCounter += 1;
  return { id: `minted-${mintedIdCounter}` };
};

const mockCollection = () => ({
  doc: (id?: string) => mockDocRef(id),
});

const tx = {
  set: vi.fn((ref: MockRef, data: any) => {
    txCalls.push({ op: 'set', ref, data });
  }),
  update: vi.fn((ref: MockRef, data: any) => {
    txCalls.push({ op: 'update', ref, data });
  }),
  delete: vi.fn((ref: MockRef) => {
    txCalls.push({ op: 'delete', ref });
  }),
};

const mockDb = {
  collection: vi.fn(() => mockCollection()),
  runTransaction: vi.fn(async (fn: (t: typeof tx) => Promise<any>) => {
    runTransactionInvocations += 1;
    if (simulateRollback) {
      // Fire the callback so any validation throw inside still surfaces, then
      // propagate the rollback error.
      try {
        await fn(tx);
      } catch {
        /* swallow — we propagate the rollback error below */
      }
      throw simulateRollback;
    }
    return fn(tx);
  }),
};

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: () => mockDb,
}));

// Import AFTER mocks are in place.
import { bulkEntityLogicFactory } from '../bulk';
import { BulkCollisionError } from '@donotdev/core/server';
import * as v from 'valibot';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createSchema = v.object({
  name: v.string(),
});
const updateSchema = v.object({
  name: v.optional(v.string()),
});

const access = {
  create: 'user' as const,
  update: 'user' as const,
  delete: 'user' as const,
};

const ctx = {
  uid: 'tester-uid',
  userRole: 'user' as const,
  request: {} as any,
};

const COLLECTION = 'cars';

function resetState() {
  txCalls.length = 0;
  mintedIdCounter = 0;
  runTransactionInvocations = 0;
  simulateRollback = null;
  tx.set.mockClear();
  tx.update.mockClear();
  tx.delete.mockClear();
  mockDb.collection.mockClear();
  mockDb.runTransaction.mockClear();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bulkEntityLogicFactory', () => {
  beforeEach(resetState);

  it('happy path: 2 inserts + 1 update + 1 delete preserves input order', async () => {
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      access
    );

    const result = await logic(
      {
        inserts: [{ name: 'Alpha' }, { name: 'Beta' }],
        updates: [{ id: 'u1', patch: { name: 'Updated' } }],
        deletes: ['d1'],
      },
      ctx
    );

    // Single transaction — the core atomicity contract.
    expect(runTransactionInvocations).toBe(1);

    // Response shape and input-order id preservation.
    expect(result.insertedIds).toEqual(['minted-1', 'minted-2']);
    expect(result.updatedIds).toEqual(['u1']);
    expect(result.deletedIds).toEqual(['d1']);

    // All ops issued within the transaction, in input order:
    // [insert, insert, update, delete].
    expect(txCalls.map((c) => c.op)).toEqual([
      'set',
      'set',
      'update',
      'delete',
    ]);

    // Inserts carry metadata + status.
    const insertCalls = txCalls.filter((c) => c.op === 'set');
    for (const call of insertCalls) {
      expect(call.data.createdById).toBe('tester-uid');
      expect(call.data.updatedById).toBe('tester-uid');
      expect(call.data.status).toBeDefined();
    }

    // Update patch carries updatedBy metadata.
    const updateCall = txCalls.find((c) => c.op === 'update') as {
      data: any;
    };
    expect(updateCall.data.updatedById).toBe('tester-uid');
  });

  it('empty bulk returns zeroed response without opening a transaction', async () => {
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      access
    );

    const result = await logic({}, ctx);

    expect(result).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
    expect(runTransactionInvocations).toBe(0);
    expect(mockDb.collection).not.toHaveBeenCalled();
  });

  it('empty bulk is idempotent across repeated calls', async () => {
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      access
    );

    const first = await logic({}, ctx);
    const second = await logic({ inserts: [], updates: [], deletes: [] }, ctx);

    expect(first).toEqual(second);
    expect(runTransactionInvocations).toBe(0);
  });

  it('rejects with BulkCollisionError when id is in updates AND deletes', async () => {
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      access
    );

    await expect(
      logic(
        {
          updates: [{ id: 'shared', patch: { name: 'X' } }],
          deletes: ['shared'],
        },
        ctx
      )
    ).rejects.toBeInstanceOf(BulkCollisionError);

    // No transaction opened.
    expect(runTransactionInvocations).toBe(0);
    expect(txCalls.length).toBe(0);
  });

  it('rejects insert that fails createSchema without opening a transaction', async () => {
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      access
    );

    await expect(
      logic(
        {
          // `name` missing — fails createSchema.
          inserts: [{ bogus: 'field' } as any],
        },
        ctx
      )
    ).rejects.toThrow(/Validation failed/);

    expect(runTransactionInvocations).toBe(0);
    expect(txCalls.length).toBe(0);
  });

  it('fails on ACL — caller lacks delete access and request contains deletes', async () => {
    const strictAccess = {
      create: 'user' as const,
      update: 'user' as const,
      delete: 'admin' as const,
    };
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      strictAccess
    );

    await expect(
      logic(
        {
          inserts: [{ name: 'OK' }],
          deletes: ['d1'],
        },
        ctx // userRole: 'user' — cannot delete.
      )
    ).rejects.toThrow(/Access denied for bulk delete/);

    expect(runTransactionInvocations).toBe(0);
    expect(txCalls.length).toBe(0);
  });

  it('allows inserts-only when caller has create but not delete access', async () => {
    const strictAccess = {
      create: 'user' as const,
      update: 'user' as const,
      delete: 'admin' as const,
    };
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      strictAccess
    );

    const result = await logic({ inserts: [{ name: 'Alpha' }] }, ctx);

    expect(result.insertedIds).toHaveLength(1);
    expect(result.deletedIds).toEqual([]);
    expect(runTransactionInvocations).toBe(1);
  });

  it('propagates transaction rollback errors (no partial writes surfaced)', async () => {
    const logic = bulkEntityLogicFactory(
      COLLECTION,
      createSchema,
      updateSchema,
      access
    );

    simulateRollback = new Error('Firestore transaction aborted');

    await expect(
      logic(
        {
          inserts: [{ name: 'Alpha' }],
        },
        ctx
      )
    ).rejects.toThrow('Firestore transaction aborted');

    // Transaction was opened, but caller sees the rollback.
    expect(runTransactionInvocations).toBe(1);
  });
});
