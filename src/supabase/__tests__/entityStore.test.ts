/**
 * @fileoverview Unit tests for `createEntityStore`: field mapping both ways,
 * publication filter, unknown fields (queries rejected, writes logged), single-row `find`, writes.
 */

import { describe, it, expect, vi } from 'vitest';


import { createEntityStore } from '../crud/entityStore.js';
import { weightedProductEntity as entity } from '@dndev/test-entities';

type Call = [string, ...unknown[]];

/**
 * Records every builder call; awaiting a write query (insert / update) resolves to
 * `result`, a read to `stored` when given (the rows an update reads first), else `result`.
 */
function fakeClient(
  result: { data: unknown; error: { message: string } | null },
  stored?: Record<string, unknown>[]
) {
  const calls: Call[] = [];
  const newQuery = () => {
    const query: Record<string, unknown> = {};
    let writes = false;
    for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not', 'contains', 'overlaps', 'order', 'limit']) {
      query[m] = (...args: unknown[]) => {
        calls.push([m, ...args]);
        if (m === 'insert' || m === 'update') writes = true;
        return query;
      };
    }
    query.then = (resolve: (r: unknown) => unknown) =>
      Promise.resolve(!writes && stored ? { data: stored, error: null } : result).then(resolve);
    return query;
  };
  const client = {
    from: (table: string) => {
      calls.push(['from', table]);
      return newQuery();
    },
  };
  return { client: client as never, calls };
}


describe('createEntityStore', () => {
  it('lists with entity names in, snake_case columns out, hidden statuses excluded', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'p1', name: 'A', weight_grams: 50 }], error: null });
    const rows = await createEntityStore(client, entity).list({
      where: [['brandId', 'in', ['b1']]],
      select: ['name', 'weightGrams'],
      orderBy: [['name', 'asc']],
    });
    expect(rows).toEqual([{ id: 'p1', name: 'A', weightGrams: 50 }]);
    expect(calls).toEqual([
      ['from', 'weighted_products'],
      ['select', 'id, name, weight_grams'],
      ['in', 'brand_id', ['b1']],
      ['not', 'status', 'in', '("draft","deleted")'],
      ['order', 'name', { ascending: true }],
    ]);
  });

  it('includeHidden drops the publication filter', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await createEntityStore(client, entity).list({ includeHidden: true });
    expect(calls.some(([m]) => m === 'not')).toBe(false);
  });

  it('rejects query fields the entity does not define; writes log them, not written (CRUD rule 8)', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await expect(createEntityStore(client, entity).list({ where: [['price', '==', 1]] })).rejects.toThrow("unknown field 'price'");
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createEntityStore(client, entity).insert([{ name: 'A', price: 1 } as never]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('price'));
    expect(calls).toContainEqual(['insert', [{ name: 'A', status: 'available' }]]);
    warn.mockRestore();
  });

  it('find returns null, one row, or fails on several', async () => {
    const none = fakeClient({ data: [], error: null });
    expect(await createEntityStore(none.client, entity).get('p1')).toBeNull();
    const two = fakeClient({ data: [{ id: 'a' }, { id: 'b' }], error: null });
    await expect(createEntityStore(two.client, entity).find({ where: [['name', '==', 'A']] })).rejects.toThrow('more than one row');
  });

  it('insert and update map keys, skip undefined, return stored rows', async () => {
    const { client, calls } = fakeClient({ data: [{ id: 'p1', weight_grams: 10 }], error: null });
    const store = createEntityStore(client, entity);
    expect(await store.insert([{ weightGrams: 10, name: 'A', brandId: undefined }])).toEqual([{ id: 'p1', weightGrams: 10 }]);
    await store.update([['id', '==', 'p1']], { weightGrams: 10 });
    // A row without status gets DEFAULT_STATUS_VALUE
    expect(calls).toContainEqual(['insert', [{ weight_grams: 10, name: 'A', status: 'available' }]]);
    expect(calls).toContainEqual(['update', { weight_grams: 10 }]);
    expect(calls).toContainEqual(['eq', 'id', 'p1']);
    await expect(store.update([], { weightGrams: 1 })).rejects.toThrow('update without a condition');
  });

  it('validates writes with the schema of their status and writes the parse output', async () => {
    const { client, calls } = fakeClient({ data: [], error: null }, [{ id: 'p1', name: 'A', status: 'available' }]);
    const store = createEntityStore(client, entity);
    // create: required field missing, wrong value type
    await expect(store.insert([{ weightGrams: 1 } as never])).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(store.insert([{ name: 'A', weightGrams: 'x' } as never])).rejects.toMatchObject({ code: 'invalid-argument' });
    // draft: required may be empty, filled values keep their format
    await store.insert([{ status: 'draft', weightGrams: 2 }]);
    expect(calls).toContainEqual(['insert', [{ status: 'draft', weight_grams: 2 }]]);
    await expect(store.insert([{ status: 'draft', weightGrams: 'x' } as never])).rejects.toMatchObject({ code: 'invalid-argument' });
    // program class (editable: false) is written by trusted code
    await store.update([['id', '==', 'p1']], { paidAt: '2026-11-17T10:00:00.000Z' });
    expect(calls).toContainEqual(['update', { paid_at: '2026-11-17T10:00:00.000Z' }]);
    // update: a required field sent must be filled in; a draft patch uses the draft schema
    await expect(store.update([['id', '==', 'p1']], { name: '' })).rejects.toMatchObject({ code: 'invalid-argument' });
    await store.update([['id', '==', 'p1']], { status: 'draft', name: null });
    expect(calls).toContainEqual(['update', { status: 'draft', name: null }]);
    // never class (generated) is not written
    await expect(store.insert([{ name: 'A', createdAt: '2026-01-01' } as never])).resolves.toEqual([]);
    expect(calls).toContainEqual(['insert', [{ name: 'A', status: 'available' }]]);
  });

  it('keeps a caller-chosen insert id (minted ids other rows reference)', async () => {
    const { client, calls } = fakeClient({ data: [], error: null });
    await createEntityStore(client, entity).insert([{ id: 'line-1', name: 'A' }, { name: 'B' }]);
    expect(calls).toContainEqual(['insert', [{ id: 'line-1', name: 'A', status: 'available' }, { name: 'B', status: 'available' }]]);
  });

  it('update: the stored status decides the schema; publishing a draft checks the whole row', async () => {
    // Stored draft edited without a status: a draft write (empty required field accepted)
    const draft = fakeClient({ data: [], error: null }, [{ id: 'p1', name: 'A', status: 'draft' }]);
    await createEntityStore(draft.client, entity).update([['id', '==', 'p1']], { name: null });
    expect(draft.calls).toContainEqual(['update', { name: null }]);
    // Only the validated rows are written: `where` plus their ids
    expect(draft.calls).toContainEqual(['in', 'id', ['p1']]);
    // Publishing a draft whose required field is empty: rejected, nothing written
    const empty = fakeClient({ data: [], error: null }, [{ id: 'p1', name: null, status: 'draft' }]);
    await expect(createEntityStore(empty.client, entity).update([['id', '==', 'p1']], { status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(empty.calls.some(([m]) => m === 'update')).toBe(false);
    // Soft-deleting it stays relaxed
    await createEntityStore(empty.client, entity).update([['id', '==', 'p1']], { status: 'deleted' });
    expect(empty.calls).toContainEqual(['update', { status: 'deleted' }]);
    // Filled in: published, only the patch keys written
    const filled = fakeClient({ data: [], error: null }, [{ id: 'p1', name: 'A', status: 'draft' }]);
    await createEntityStore(filled.client, entity).update([['id', '==', 'p1']], { status: 'available' });
    expect(filled.calls).toContainEqual(['update', { status: 'available' }]);
    // No matching row: nothing written
    const none = fakeClient({ data: [], error: null }, []);
    expect(await createEntityStore(none.client, entity).update([['id', '==', 'p9']], { name: 'B' })).toEqual([]);
    expect(none.calls.some(([m]) => m === 'update')).toBe(false);
  });

  it('surfaces database errors', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(createEntityStore(client, entity).list()).rejects.toThrow('list weighted_products: boom');
  });
});
