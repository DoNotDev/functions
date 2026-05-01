// packages/functions/src/vercel/__tests__/bulk.test.ts

/**
 * @fileoverview Tests for the Vercel bulk CRUD API handler.
 * @description Unit tests for `POST /api/crud/:collection/bulk`. The Firebase
 *   Admin SDK is mocked — these tests exercise the handler's wire contract:
 *   parsing, collision rejection, transactional atomicity, method guard, and
 *   response shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the handler.
// ---------------------------------------------------------------------------

// Auth: resolve to a fixed uid for all tests.
vi.mock('../../shared/utils/internal/auth.js', () => ({
  verifyAuthToken: vi.fn(() => Promise.resolve('user-1')),
}));

// Collection-name validator: accept everything in tests.
vi.mock('../../shared/utils.js', () => ({
  validateCollectionName: vi.fn(),
  DoNotDevError: class DoNotDevError extends Error {
    code: string;
    details: any;
    constructor(message: string, code = 'internal', opts?: any) {
      super(message);
      this.name = 'DoNotDevError';
      this.code = code;
      this.details = opts?.details;
    }
  },
}));

// Metadata helpers — deterministic output for snapshot-like assertions.
// `executeBulk` is the real orchestrator so end-to-end behaviour (collision
// detection, empty short-circuit, transact invocation) exercises the shared
// core.
vi.mock('../../shared/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../shared/index.js')>(
    '../../shared/index.js'
  );
  return {
    ...actual,
    prepareForFirestore: (obj: Record<string, unknown>) => ({ ...obj }),
    transformFirestoreData: (obj: Record<string, unknown>) => ({ ...obj }),
    createMetadata: (uid: string) => ({
      createdAt: 'now',
      updatedAt: 'now',
      createdById: uid,
      updatedById: uid,
    }),
    updateMetadata: (uid: string) => ({
      updatedAt: 'now',
      updatedById: uid,
    }),
  };
});

// ---------------------------------------------------------------------------
// Firebase Admin SDK — shared spy surface so each test can assert calls.
// ---------------------------------------------------------------------------

type TxSpy = {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  delete: ReturnType<typeof vi.fn>;
};

let txSpy: TxSpy;
let existingDocIds: Set<string>;
let mintedIds: string[];
let mintedIdx: number;

vi.mock('@donotdev/firebase/server', () => {
  const doc = (id?: string) => {
    const docId = id ?? mintedIds[mintedIdx++] ?? `auto-${mintedIdx}`;
    return { id: docId, _id: docId };
  };
  const collection = (_name: string) => ({ doc });

  const runTransaction = vi.fn(async (work: (tx: any) => Promise<any>) => {
    txSpy = {
      get: vi.fn(async (ref: any) => ({
        exists: existingDocIds.has(ref.id),
        id: ref.id,
        data: () => ({}),
      })),
      set: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    };
    return await work(txSpy);
  });

  return {
    getFirebaseAdminFirestore: () => ({
      collection,
      runTransaction,
    }),
  };
});

// Error handling: keep real `handleError` (throws DoNotDevError-shaped) so the
// response mapping in the handler runs end-to-end.
vi.mock('../../shared/errorHandling.js', async () => {
  class DoNotDevError extends Error {
    code: string;
    constructor(message: string, code = 'internal') {
      super(message);
      this.name = 'DoNotDevError';
      this.code = code;
    }
  }
  return {
    DoNotDevError,
    handleError: (err: unknown) => {
      if (err instanceof DoNotDevError) throw err;
      if (err instanceof Error && err.name === 'BulkCollisionError') {
        throw new DoNotDevError(err.message, 'invalid-argument');
      }
      if (err instanceof Error && err.name === 'ValiError') {
        throw new DoNotDevError('Validation failed', 'invalid-argument');
      }
      throw new DoNotDevError(
        err instanceof Error ? err.message : 'Internal',
        'internal'
      );
    },
  };
});

// ---------------------------------------------------------------------------
// Import handler AFTER mocks.
// ---------------------------------------------------------------------------

import handler from '../api/crud/bulk.js';

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

function makeRes() {
  const res: any = {};
  res.status = vi.fn((code: number) => {
    res._status = code;
    return res;
  });
  res.json = vi.fn((body: unknown) => {
    res._body = body;
    return res;
  });
  return res;
}

function makeReq(opts: {
  method?: string;
  collection?: string | string[];
  body?: unknown;
}) {
  return {
    method: opts.method ?? 'POST',
    query: { collection: opts.collection ?? 'events' },
    body: opts.body,
    headers: { authorization: 'Bearer test' },
  } as any;
}

beforeEach(() => {
  existingDocIds = new Set();
  mintedIds = [];
  mintedIdx = 0;
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe('vercel bulk handler — happy path', () => {
  it('runs 2 inserts + 1 update + 1 delete in a single transaction', async () => {
    existingDocIds = new Set(['u1', 'd1']);
    mintedIds = ['new-1', 'new-2'];

    const req = makeReq({
      body: {
        inserts: [{ title: 'A' }, { title: 'B' }],
        updates: [{ id: 'u1', patch: { title: 'renamed' } }],
        deletes: ['d1'],
      },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      insertedIds: ['new-1', 'new-2'],
      updatedIds: ['u1'],
      deletedIds: ['d1'],
    });
    // One transaction, N writes inside it.
    expect(txSpy.set).toHaveBeenCalledTimes(2);
    expect(txSpy.update).toHaveBeenCalledTimes(1);
    expect(txSpy.delete).toHaveBeenCalledTimes(1);
  });
});

describe('vercel bulk handler — empty payload', () => {
  it('returns zeroed response without touching the DB', async () => {
    const req = makeReq({ body: {} });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(200);
    expect(res._body).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
    // No transaction spy created → no DB work.
    expect(txSpy).toBeUndefined();
  });
});

describe('vercel bulk handler — collision rejection', () => {
  it('rejects id present in both updates and deletes', async () => {
    const req = makeReq({
      body: {
        updates: [{ id: 'x', patch: { a: 1 } }],
        deletes: ['x'],
      },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect((res._body as any).error).toMatch(/BulkCollisionError/);
    expect(txSpy).toBeUndefined();
  });
});

describe('vercel bulk handler — validation failure', () => {
  it('rolls back when an update targets a non-existent doc', async () => {
    // `u1` not in existingDocIds → tx.get returns `exists: false` → throw.
    existingDocIds = new Set();
    mintedIds = ['new-1'];

    const req = makeReq({
      body: {
        inserts: [{ title: 'A' }],
        updates: [{ id: 'u1', patch: { title: 'x' } }],
      },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(500);
    // No writes issued — existence check runs before any tx.set/update/delete.
    expect(txSpy.set).not.toHaveBeenCalled();
    expect(txSpy.update).not.toHaveBeenCalled();
    expect(txSpy.delete).not.toHaveBeenCalled();
  });

  it('rejects structurally invalid body (ACL-equivalent schema check)', async () => {
    // `updates[0]` missing required `id` — schema rejects before DB access.
    const req = makeReq({
      body: {
        updates: [{ patch: { title: 'x' } }],
      },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(txSpy).toBeUndefined();
  });
});

describe('vercel bulk handler — method guard', () => {
  it('rejects GET with 405', async () => {
    const req = makeReq({ method: 'GET', body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });

  it('rejects PUT with 405', async () => {
    const req = makeReq({ method: 'PUT', body: {} });
    const res = makeRes();
    await handler(req, res);
    expect(res._status).toBe(405);
  });
});
