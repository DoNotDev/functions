// packages/functions/src/shared/__tests__/bulkCore.test.ts

/**
 * @fileoverview Unit tests for {@link executeBulk}.
 * @description Exercises the shared orchestration contract directly with a
 *   mock `transact` callback — empty short-circuit, collision rejection,
 *   per-bucket ACL, per-row validation (inserts + updates), single-invocation
 *   transact with prepared payload, response-schema validation, and audit
 *   firing once with counts.
 */

import { describe, it, expect, vi } from 'vitest';
import * as v from 'valibot';

import { executeBulk } from '../crud/bulkCore.js';
import { BulkCollisionError } from '@donotdev/core/server';
import { DoNotDevError } from '@donotdev/core/server';
import { DEFAULT_STATUS_VALUE } from '@donotdev/core/server';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const createSchema = v.object({ name: v.pipe(v.string(), v.minLength(1)) });
const updateSchema = v.object({ name: v.optional(v.string()) });

const ACCESS = {
  create: 'user' as const,
  read: 'user' as const,
  update: 'user' as const,
  delete: 'user' as const,
};

/** Default response-shape returned by the mock transact. */
function okResponse(prepared: {
  inserts: Array<{ id: string; row: Record<string, unknown> }>;
  updates: Array<{ id: string; patch: Record<string, unknown> }>;
  deletes: string[];
}) {
  return {
    insertedIds: prepared.inserts.map((i, idx) => i.id || `auto-${idx + 1}`),
    updatedIds: prepared.updates.map((u) => u.id),
    deletedIds: [...prepared.deletes],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('executeBulk (shared CRUD core)', () => {
  it('empty bulk short-circuits: no transact, no audit', async () => {
    const transact = vi.fn();
    const audit = vi.fn();

    const result = await executeBulk({
      collection: 'events',
      ops: {},
      createSchema,
      updateSchema,
      access: ACCESS,
      uid: 'u1',
      userRole: 'user',
      transact,
      audit,
    });

    expect(result).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
    expect(transact).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('empty arrays also short-circuit', async () => {
    const transact = vi.fn();
    const audit = vi.fn();

    const result = await executeBulk({
      collection: 'events',
      ops: { inserts: [], updates: [], deletes: [] },
      createSchema,
      updateSchema,
      access: ACCESS,
      uid: 'u1',
      userRole: 'user',
      transact,
      audit,
    });

    expect(result).toEqual({
      insertedIds: [],
      updatedIds: [],
      deletedIds: [],
    });
    expect(transact).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects with BulkCollisionError on updates/deletes collision, no transact', async () => {
    const transact = vi.fn();
    const audit = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: {
          updates: [{ id: 'a', patch: { name: 'x' } }],
          deletes: ['a'],
        },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
        audit,
      })
    ).rejects.toBeInstanceOf(BulkCollisionError);

    expect(transact).not.toHaveBeenCalled();
    expect(audit).not.toHaveBeenCalled();
  });

  it('rejects with BulkCollisionError on inserts/updates id collision', async () => {
    const transact = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: {
          inserts: [{ id: 'shared', name: 'new' }],
          updates: [{ id: 'shared', patch: { name: 'x' } }],
        },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      where: 'inserts-updates',
      collidingIds: ['shared'],
    });
    expect(transact).not.toHaveBeenCalled();
  });

  it('per-bucket ACL: populated deletes bucket rejects when role insufficient', async () => {
    const transact = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: { deletes: ['a', 'b'] },
        createSchema,
        updateSchema,
        access: { ...ACCESS, delete: 'admin' },
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('admin'),
    });

    expect(transact).not.toHaveBeenCalled();
  });

  it('per-bucket ACL: populated bucket without configured role is a config error', async () => {
    const transact = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: { inserts: [{ name: 'A' }] },
        createSchema,
        updateSchema,
        access: { read: 'user' }, // no create role configured
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('no create role is configured'),
    });

    expect(transact).not.toHaveBeenCalled();
  });

  it('empty-bucket ACL: unpopulated buckets do not block execution', async () => {
    // Only the update bucket carries work; a deletes-without-role config does
    // NOT fail because the deletes bucket is empty.
    const transact = vi.fn(okResponse);

    const result = await executeBulk({
      collection: 'events',
      ops: { updates: [{ id: 'u1', patch: { name: 'x' } }] },
      createSchema,
      updateSchema,
      access: { update: 'user' }, // no create/delete roles configured — fine
      uid: 'u1',
      userRole: 'user',
      transact,
    });

    expect(transact).toHaveBeenCalledTimes(1);
    expect(result.updatedIds).toEqual(['u1']);
  });

  it('validation failure on insert: prefixed with inserts[i], no transact', async () => {
    const transact = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: {
          inserts: [{ name: 'Alice' }, { name: '' }], // index 1 invalid
        },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('inserts[1]'),
    });

    expect(transact).not.toHaveBeenCalled();
  });

  it('validation failure on update patch: prefixed with updates[i], no transact', async () => {
    const transact = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: {
          updates: [{ id: 'u1', patch: { name: 123 as any } }],
        },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('updates[0]'),
    });

    expect(transact).not.toHaveBeenCalled();
  });

  it('wire-schema failure throws invalid-argument without calling transact', async () => {
    const transact = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        // Malformed: updates[0] missing `id`.
        ops: { updates: [{ patch: { name: 'x' } } as any] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: expect.stringContaining('Bulk payload validation failed'),
    });

    expect(transact).not.toHaveBeenCalled();
  });

  it('transact called exactly once with prepared payload (minted ids + stamped metadata)', async () => {
    let mintCounter = 0;
    const transact = vi.fn(okResponse);
    const audit = vi.fn();

    const result = await executeBulk({
      collection: 'events',
      ops: {
        inserts: [{ name: 'Alice' }, { name: 'Bob' }],
        updates: [{ id: 'u1', patch: { name: 'Renamed' } }],
        deletes: ['d1'],
      },
      createSchema,
      updateSchema,
      access: ACCESS,
      uid: 'user-1',
      userRole: 'user',
      mintInsertId: () => `mint-${++mintCounter}`,
      stampInsertMetadata: (row, uid) => ({ ...row, _uid: uid, _kind: 'ins' }),
      stampUpdateMetadata: (patch, uid) => ({
        ...patch,
        _uid: uid,
        _kind: 'upd',
      }),
      transact,
      audit,
    });

    expect(transact).toHaveBeenCalledTimes(1);
    const [prepared] = transact.mock.calls[0];
    expect(prepared.inserts).toEqual([
      {
        id: 'mint-1',
        row: {
          name: 'Alice',
          status: DEFAULT_STATUS_VALUE,
          _uid: 'user-1',
          _kind: 'ins',
        },
      },
      {
        id: 'mint-2',
        row: {
          name: 'Bob',
          status: DEFAULT_STATUS_VALUE,
          _uid: 'user-1',
          _kind: 'ins',
        },
      },
    ]);
    expect(prepared.updates).toEqual([
      {
        id: 'u1',
        patch: { name: 'Renamed', _uid: 'user-1', _kind: 'upd' },
      },
    ]);
    expect(prepared.deletes).toEqual(['d1']);

    // Response echoes input order.
    expect(result.insertedIds).toEqual(['mint-1', 'mint-2']);
    expect(result.updatedIds).toEqual(['u1']);
    expect(result.deletedIds).toEqual(['d1']);
  });

  it('transact runs without mintInsertId: id is empty string, target mints its own', async () => {
    const transact = vi.fn(() =>
      // Target mints server-side and returns the ids.
      Promise.resolve({
        insertedIds: ['srv-1'],
        updatedIds: [],
        deletedIds: [],
      })
    );

    const result = await executeBulk({
      collection: 'events',
      ops: { inserts: [{ name: 'Alice' }] },
      createSchema,
      updateSchema,
      access: ACCESS,
      uid: 'user-1',
      userRole: 'user',
      transact,
    });

    const [prepared] = transact.mock.calls[0];
    expect(prepared.inserts).toEqual([
      { id: '', row: { name: 'Alice', status: DEFAULT_STATUS_VALUE } },
    ]);
    expect(result.insertedIds).toEqual(['srv-1']);
  });

  it('response-schema validation rejects a malformed transact return', async () => {
    const transact = vi.fn(() =>
      Promise.resolve({
        // Missing updatedIds + deletedIds — not a BulkResponse.
        insertedIds: ['a'],
      } as any)
    );

    await expect(
      executeBulk({
        collection: 'events',
        ops: { inserts: [{ name: 'A' }] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({
      code: 'internal',
      message: expect.stringContaining('unexpected shape'),
    });
  });

  it('audit fires once with correct counts on success', async () => {
    const transact = vi.fn(okResponse);
    const audit = vi.fn();

    await executeBulk({
      collection: 'events',
      ops: {
        inserts: [{ name: 'A' }, { name: 'B' }, { name: 'C' }],
        updates: [{ id: 'u1', patch: { name: 'x' } }],
        deletes: ['d1', 'd2'],
      },
      createSchema,
      updateSchema,
      access: ACCESS,
      uid: 'u1',
      userRole: 'user',
      transact,
      audit,
    });

    expect(audit).toHaveBeenCalledTimes(1);
    expect(audit).toHaveBeenCalledWith('crud.bulk.events', {
      counts: { inserts: 3, updates: 1, deletes: 2 },
    });
  });

  it('audit does NOT fire when transact throws', async () => {
    const transact = vi.fn(() =>
      Promise.reject(new Error('transaction aborted'))
    );
    const audit = vi.fn();

    await expect(
      executeBulk({
        collection: 'events',
        ops: { inserts: [{ name: 'A' }] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
        audit,
      })
    ).rejects.toThrow('transaction aborted');

    expect(audit).not.toHaveBeenCalled();
  });

  it('propagates non-DoNotDevError transact failures unchanged (for caller classification)', async () => {
    const boom = new Error('deadlock');
    const transact = vi.fn(() => Promise.reject(boom));

    await expect(
      executeBulk({
        collection: 'events',
        ops: { inserts: [{ name: 'A' }] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toBe(boom);
  });

  it('DoNotDevError from transact propagates unchanged', async () => {
    const boom = new DoNotDevError('rpc failure', 'internal');
    const transact = vi.fn(() => Promise.reject(boom));

    await expect(
      executeBulk({
        collection: 'events',
        ops: { inserts: [{ name: 'A' }] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toBe(boom);
  });
});
