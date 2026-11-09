/**
 * @fileoverview Unit tests for `createEntityStore`: field mapping both ways,
 * publication filter, unknown-field rejection, single-row `find`, writes.
 */

import { describe, it, expect } from 'vitest';

import { createEntityStore } from '../crud/entityStore.js';

type Call = [string, ...unknown[]];

/** Records every builder call; awaiting the query resolves to `result`. */
function fakeClient(result: { data: unknown; error: { message: string } | null }) {
  const calls: Call[] = [];
  const query: Record<string, unknown> = {};
  for (const m of ['select', 'insert', 'update', 'eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'not', 'contains', 'overlaps', 'order', 'limit']) {
    query[m] = (...args: unknown[]) => {
      calls.push([m, ...args]);
      return query;
    };
  }
  query.then = (resolve: (r: unknown) => unknown) => Promise.resolve(result).then(resolve);
  const client = {
    from: (table: string) => {
      calls.push(['from', table]);
      return query;
    },
  };
  return { client: client as never, calls };
}

const entity = {
  name: 'Product',
  collection: 'products',
  fields: { id: {}, status: {}, name: {}, weightGrams: {}, brandId: {} },
} as never;

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
      ['from', 'products'],
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

  it('rejects fields the entity does not define', async () => {
    const { client } = fakeClient({ data: [], error: null });
    await expect(createEntityStore(client, entity).list({ where: [['price', '==', 1]] })).rejects.toThrow("unknown field 'price'");
    await expect(createEntityStore(client, entity).insert([{ price: 1 } as never])).rejects.toThrow("unknown field 'price'");
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
    expect(await store.insert([{ weightGrams: 10, name: undefined }])).toEqual([{ id: 'p1', weightGrams: 10 }]);
    await store.update([['id', '==', 'p1']], { weightGrams: 10 });
    expect(calls).toContainEqual(['insert', [{ weight_grams: 10 }]]);
    expect(calls).toContainEqual(['update', { weight_grams: 10 }]);
    expect(calls).toContainEqual(['eq', 'id', 'p1']);
    await expect(store.update([], { weightGrams: 1 })).rejects.toThrow('update without a condition');
  });

  it('surfaces database errors', async () => {
    const { client } = fakeClient({ data: null, error: { message: 'boom' } });
    await expect(createEntityStore(client, entity).list()).rejects.toThrow('list products: boom');
  });
});
