/**
 * @fileoverview Unit tests for `createSupabaseBulkEntity`.
 * @description Exercises happy-path, empty-bulk short-circuit, collision rejection,
 *   validation failure, ACL failure, and field-mapping preservation. The base
 *   handler wrapper (`createSupabaseHandler`) is stubbed so tests invoke the
 *   inner business logic directly without needing a mock Deno `Request`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as v from 'valibot';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// Stub the wrapper so the factory returns `(data, ctx) => handler(...)` instead
// of a Request-based handler. This lets us call the business logic directly
// and assert on its behaviour without mocking a full Deno runtime.
vi.mock('../baseFunction.js', () => ({
  createSupabaseHandler: vi.fn(
    (_operationName: string, _schema: unknown, handler: any) => handler
  ),
}));

// Field mapper stub — identity roundtrip is enough to prove mapping is invoked
// (we spy on the calls and verify snake_case output in the happy path).
vi.mock('@donotdev/supabase/server', () => ({
  defaultFieldMapper: {
    toBackendField: (f: string) => f,
    toBackendKeys: (o: Record<string, unknown>) => {
      // Convert camelCase → snake_case for the keys we stamp as metadata.
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(o)) {
        const snake = k.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`);
        out[snake] = v;
      }
      return out;
    },
    fromBackendRow: (r: Record<string, unknown>) => r,
  },
}));

// Import after mocks so the bulk module picks them up.
import { createSupabaseBulkEntity } from '../crud/bulk.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CreateSchema = v.object({
  name: v.pipe(v.string(), v.minLength(1)),
});
const UpdateSchema = v.object({
  name: v.optional(v.string()),
});

const access = {
  create: 'user' as const,
  read: 'user' as const,
  update: 'user' as const,
  delete: 'user' as const,
};

/** Build a bulk handler + a stubbed Supabase admin client. */
function setup(opts?: {
  rpcResult?: unknown;
  rpcError?: { message: string } | null;
}) {
  const rpcSpy = vi.fn().mockResolvedValue({
    data: opts?.rpcResult ?? {
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    },
    error: opts?.rpcError ?? null,
  });
  const supabaseAdmin = { rpc: rpcSpy } as unknown as any;

  const inner = createSupabaseBulkEntity(
    'events',
    CreateSchema,
    UpdateSchema,
    access
  ) as unknown as (data: any, ctx: any) => Promise<any>;

  return {
    handler: inner,
    rpcSpy,
    ctx: {
      uid: 'user-1',
      userRole: 'user' as const,
      supabaseAdmin,
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createSupabaseBulkEntity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: 2 inserts + 1 update + 1 delete → calls RPC once, returns echoed ids in input order', async () => {
    const rpcResult = {
      insertedIds: ['new-1', 'new-2'],
      updatedIds: ['u-1'],
      deletedIds: ['d-1'],
    };
    const { handler, rpcSpy, ctx } = setup({ rpcResult });

    const result = await handler(
      {
        inserts: [{ name: 'Alice' }, { name: 'Bob' }],
        updates: [{ id: 'u-1', patch: { name: 'Updated' } }],
        deletes: ['d-1'],
      },
      ctx
    );

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    expect(rpcSpy).toHaveBeenCalledWith(
      'crud_bulk',
      expect.objectContaining({
        p_collection: 'events',
        p_inserts: expect.any(Array),
        p_updates: expect.any(Array),
        p_deletes: ['d-1'],
      })
    );
    expect(result).toEqual(rpcResult);
  });

  it('empty bulk short-circuits: no RPC call, zeroed response', async () => {
    const { handler, rpcSpy, ctx } = setup();

    const result = await handler({}, ctx);

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
  });

  it('empty arrays also short-circuit (no RPC call)', async () => {
    const { handler, rpcSpy, ctx } = setup();

    const result = await handler(
      { inserts: [], updates: [], deletes: [] },
      ctx
    );

    expect(rpcSpy).not.toHaveBeenCalled();
    expect(result).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
  });

  it('collision rejection (updates + deletes): throws, no RPC', async () => {
    const { handler, rpcSpy, ctx } = setup();

    await expect(
      handler(
        {
          updates: [{ id: 'a', patch: { name: 'X' } }],
          deletes: ['a'],
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('BulkCollisionError'),
      details: expect.objectContaining({
        collidingIds: ['a'],
        where: 'updates-deletes',
      }),
    });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('validation failure on insert: rejects before any RPC write', async () => {
    const { handler, rpcSpy, ctx } = setup();

    await expect(
      handler(
        {
          inserts: [{ name: 'Alice' }, { name: '' }], // second one invalid
          updates: [{ id: 'u-1', patch: { name: 'Ok' } }],
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('inserts[1]'),
    });

    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('validation failure on update patch: rejects before any RPC write', async () => {
    const { handler, rpcSpy, ctx } = setup();

    await expect(
      handler(
        {
          updates: [{ id: 'u-1', patch: { name: 123 as any } }], // number not string
        },
        ctx
      )
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('updates[0]'),
    });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('ACL failure: user lacks delete role → rejects, no RPC', async () => {
    const rpcSpy = vi.fn();
    const supabaseAdmin = { rpc: rpcSpy } as unknown as any;

    const inner = createSupabaseBulkEntity(
      'events',
      CreateSchema,
      UpdateSchema,
      { ...access, delete: 'admin' }
    ) as unknown as (data: any, ctx: any) => Promise<any>;

    await expect(
      inner(
        { deletes: ['a', 'b'] },
        { uid: 'u', userRole: 'user', supabaseAdmin }
      )
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('admin'),
    });
    expect(rpcSpy).not.toHaveBeenCalled();
  });

  it('field-mapping: inserts carry snake_case metadata (created_at, created_by_id) via toBackendKeys', async () => {
    const rpcResult = {
      insertedIds: ['n-1'],
      updatedIds: [],
      deletedIds: [],
    };
    const { handler, rpcSpy, ctx } = setup({ rpcResult });

    await handler({ inserts: [{ name: 'Alice' }] }, ctx);

    expect(rpcSpy).toHaveBeenCalledTimes(1);
    const call = rpcSpy.mock.calls[0];
    const args = call[1];
    const firstInsert = args.p_inserts[0];

    // Metadata keys came from createMetadata() and were snake-cased by our
    // stubbed toBackendKeys.
    expect(firstInsert).toMatchObject({
      name: 'Alice',
      created_by_id: 'user-1',
      updated_by_id: 'user-1',
    });
    expect(firstInsert.created_at).toBeDefined();
    expect(firstInsert.updated_at).toBeDefined();
  });

  it('field-mapping: updates carry snake_case metadata (updated_at, updated_by_id), no created_* leakage', async () => {
    const rpcResult = {
      insertedIds: [],
      updatedIds: ['u-1'],
      deletedIds: [],
    };
    const { handler, rpcSpy, ctx } = setup({ rpcResult });

    await handler(
      { updates: [{ id: 'u-1', patch: { name: 'Renamed' } }] },
      ctx
    );

    const args = rpcSpy.mock.calls[0][1];
    const firstPatch = args.p_updates[0].patch;

    expect(firstPatch).toMatchObject({
      name: 'Renamed',
      updated_by_id: 'user-1',
    });
    expect(firstPatch.updated_at).toBeDefined();
    expect(firstPatch.created_by_id).toBeUndefined();
    expect(firstPatch.created_at).toBeUndefined();
  });

  it('RPC error surfaces as DoNotDevError (transaction-level failure)', async () => {
    const { handler, ctx } = setup({
      rpcError: { message: 'deadlock detected' },
    });

    await expect(handler({ deletes: ['a'] }, ctx)).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('bulk'),
    });
  });

  it('input order is preserved in RPC payload', async () => {
    const rpcResult = {
      insertedIds: ['n-1', 'n-2', 'n-3'],
      updatedIds: ['u-1', 'u-2'],
      deletedIds: ['d-1', 'd-2'],
    };
    const { handler, rpcSpy, ctx } = setup({ rpcResult });

    const inserts = [{ name: 'A' }, { name: 'B' }, { name: 'C' }];
    const updates = [
      { id: 'u-1', patch: { name: 'X' } },
      { id: 'u-2', patch: { name: 'Y' } },
    ];
    const deletes = ['d-1', 'd-2'];

    await handler({ inserts, updates, deletes }, ctx);

    const args = rpcSpy.mock.calls[0][1];
    expect(args.p_inserts.map((r: any) => r.name)).toEqual(['A', 'B', 'C']);
    expect(args.p_updates.map((u: any) => u.id)).toEqual(['u-1', 'u-2']);
    expect(args.p_deletes).toEqual(['d-1', 'd-2']);
  });
});
