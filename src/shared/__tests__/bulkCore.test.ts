// packages/functions/src/shared/__tests__/bulkCore.test.ts

/**
 * @fileoverview Unit tests for {@link executeBulk}.
 * @description Exercises the shared orchestration contract directly with a
 *   mock `transact` callback — empty short-circuit, collision rejection,
 *   per-bucket ACL, per-row validation (inserts + updates), single-invocation
 *   transact with prepared payload, response-schema validation, and audit
 *   firing once with counts.
 */

import * as v from 'valibot';
import { describe, it, expect, vi } from 'vitest';

import { BulkCollisionError } from '@donotdev/core/server';
import { DoNotDevError } from '@donotdev/core/server';
import { DEFAULT_STATUS_VALUE } from '@donotdev/core/server';
import { createSchemas } from '@donotdev/core/server';

import { executeBulk } from '../crud/bulkCore.js';
import { contactEntity } from '@dndev/test-entities';

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

/** Stored rows of the mock store: every updated id exists, published, unless listed. */
let storedRows: Record<string, Record<string, unknown>> = {};
const readStored = async (ids: readonly string[]) =>
  new Map(ids.map((id) => [id, storedRows[id] ?? { status: 'available' }]));

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
      readStored,
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
      readStored,
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
        readStored,
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
        readStored,
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
        readStored,
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
        readStored,
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
      readStored,
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
        readStored,
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
        readStored,
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

  it('validates updates with the entity schemas: draft patch → draft schema, other → update schema (with the id)', async () => {
    const schemas = createSchemas(contactEntity);
    const run = (patch: Record<string, unknown>) =>
      executeBulk({
        collection: 'contacts',
        ops: { updates: [{ id: 'c1', patch }] },
        createSchema: schemas.create,
        draftCreateSchema: schemas.draft,
        updateSchema: schemas.update,
        access: ACCESS,
        readStored,
        uid: 'u1',
        userRole: 'user',
        transact: async (prepared) => okResponse(prepared),
      });
    await expect(run({ name: 'Ana' })).resolves.toMatchObject({ updatedIds: ['c1'] });
    await expect(run({ status: 'draft', name: null })).resolves.toMatchObject({ updatedIds: ['c1'] });
    for (const patch of [{ name: null }, { name: '' }, { status: 'draft', phone: 'TOTO' }]) {
      await expect(run(patch)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
  });

  it('stores the parse output: unknown keys dropped from inserts and patches', async () => {
    const transact = vi.fn(okResponse);
    await executeBulk({
      collection: 'events',
      ops: {
        inserts: [{ name: 'Alice', role: 'admin' }],
        updates: [{ id: 'u1', patch: { name: 'Bob', createdById: 'evil' } }],
      },
      createSchema,
      updateSchema,
      access: ACCESS,
      readStored,
      uid: 'u1',
      userRole: 'user',
      transact,
    });
    const prepared = transact.mock.calls[0]![0];
    expect(prepared.inserts[0]!.row).toEqual({ name: 'Alice', status: DEFAULT_STATUS_VALUE });
    expect(prepared.updates[0]!.patch).toEqual({ name: 'Bob' });
  });

  it('keeps a client-supplied insert id (pre-minted, referenced by other rows) when the target mints', async () => {
    const schemas = createSchemas(contactEntity);
    const transact = vi.fn(okResponse);
    await executeBulk({
      collection: 'lines',
      ops: { inserts: [{ id: 'line-1', name: 'A' }, { name: 'B' }] },
      createSchema: schemas.create,
      updateSchema: schemas.update,
      access: ACCESS,
      readStored,
      uid: 'u1',
      userRole: 'user',
      transact,
    });
    const prepared = transact.mock.calls[0]![0];
    expect(prepared.inserts[0]).toMatchObject({ id: 'line-1', row: { id: 'line-1', name: 'A' } });
    expect(prepared.inserts[1]!.id).toBe('');
    expect(prepared.inserts[1]!.row).not.toHaveProperty('id');
  });

  it('with mintInsertId the minted id wins over a client id', async () => {
    const transact = vi.fn(okResponse);
    await executeBulk({
      collection: 'events',
      ops: { inserts: [{ id: 'client-1', name: 'A' }] },
      createSchema,
      updateSchema,
      access: ACCESS,
      readStored,
      uid: 'u1',
      userRole: 'user',
      mintInsertId: () => 'minted-1',
      transact,
    });
    const prepared = transact.mock.calls[0]![0];
    expect(prepared.inserts[0]!.id).toBe('minted-1');
    expect(prepared.inserts[0]!.row).not.toHaveProperty('id');
  });

  it('update schema from the resulting status (patch ?? stored): a stored draft edit stays a draft write', async () => {
    const schemas = createSchemas(contactEntity);
    const transact = vi.fn(okResponse);
    const run = (patch: Record<string, unknown>) =>
      executeBulk({
        collection: 'contacts',
        ops: { updates: [{ id: 'c1', patch }] },
        createSchema: schemas.create,
        draftCreateSchema: schemas.draft,
        updateSchema: schemas.update,
        access: ACCESS,
        readStored,
        uid: 'u1',
        userRole: 'user',
        transact,
      });
    // Client form edit of a stored draft by a viewer who cannot edit status
    storedRows = { c1: { id: 'c1', name: 'Ana', status: 'draft' } };
    await expect(run({ name: null })).resolves.toMatchObject({ updatedIds: ['c1'] });
    // Publishing through a status-only patch: the whole stored row is checked
    storedRows = { c1: { id: 'c1', name: null, status: 'draft' } };
    await expect(run({ status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument', message: expect.stringContaining('updates[0]') });
    storedRows = { c1: { id: 'c1', status: 'draft' } };
    await expect(run({ status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument' });
    // Soft-deleting a draft stays relaxed
    storedRows = { c1: { id: 'c1', name: null, status: 'draft' } };
    await expect(run({ status: 'deleted' })).resolves.toMatchObject({ updatedIds: ['c1'] });
    // Filled in: published, only the sent keys written
    transact.mockClear();
    storedRows = { c1: { id: 'c1', name: 'Ana', status: 'draft' } };
    await run({ status: 'available' });
    expect(transact.mock.calls[0]![0].updates[0]!.patch).toEqual({ status: 'available' });
    storedRows = {};
  });

  it('updates without readStored are rejected (internal), no transact', async () => {
    const transact = vi.fn(okResponse);
    await expect(
      executeBulk({
        collection: 'events',
        ops: { updates: [{ id: 'e1', patch: { name: 'x' } }] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({ code: 'internal', message: expect.stringContaining('readStored') });
    expect(transact).not.toHaveBeenCalled();
  });

  it('inserts and deletes need no readStored', async () => {
    await expect(
      executeBulk({
        collection: 'events',
        ops: { inserts: [{ name: 'a' }], deletes: ['e9'] },
        createSchema,
        updateSchema,
        access: ACCESS,
        uid: 'u1',
        userRole: 'user',
        transact: async (prepared) => okResponse(prepared),
      })
    ).resolves.toMatchObject({ deletedIds: ['e9'] });
  });

  it('an updated id with no stored row is rejected (not-found), no transact', async () => {
    const transact = vi.fn(okResponse);
    await expect(
      executeBulk({
        collection: 'events',
        ops: { updates: [{ id: 'gone', patch: { name: 'x' } }] },
        createSchema,
        updateSchema,
        access: ACCESS,
        readStored: async () => new Map(),
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toMatchObject({ code: 'not-found', message: expect.stringContaining('updates[0]') });
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
        readStored,
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
      readStored,
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
      readStored,
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
        readStored,
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
      readStored,
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
        readStored,
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
        readStored,
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
        readStored,
        uid: 'u1',
        userRole: 'user',
        transact,
      })
    ).rejects.toBe(boom);
  });
});
