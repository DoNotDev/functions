/**
 * @fileoverview Unit tests for `createSupabaseAggregateEntities`.
 * @description Regression: filters were applied on `from()` (no filter methods) and
 *   grouping called a non-existent `.group()`, so any `where` or `groupBy` threw.
 */

import * as v from 'valibot';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../baseFunction.js', () => ({
  createSupabaseHandler: vi.fn(
    (_operationName: string, _schema: unknown, handler: any) => handler
  ),
}));

vi.mock('@donotdev/supabase/server', () => ({
  defaultFieldMapper: {
    toBackendField: (f: string) =>
      f.replace(/[A-Z]/g, (m) => `_${m.toLowerCase()}`),
  },
}));

import { createSupabaseAggregateEntities } from '../crud/aggregate.js';

type Result = { data: unknown[] | null; error: null; count: number | null };

/** Minimal PostgREST stub: from() has only select(); filters live on the builder. */
function setup(result: Result) {
  const calls: Array<[string, ...unknown[]]> = [];
  const builder: Record<string, unknown> = {
    then: (resolve: (r: Result) => unknown) => resolve(result),
  };
  for (const op of [
    'eq',
    'neq',
    'gt',
    'gte',
    'lt',
    'lte',
    'in',
    'not',
    'contains',
  ]) {
    builder[op] = (...args: unknown[]) => {
      calls.push([op, ...args]);
      return builder;
    };
  }
  const select = vi.fn((...args: unknown[]) => {
    calls.push(['select', ...args]);
    return builder;
  });
  const supabaseAdmin = { from: vi.fn(() => ({ select })) };
  const handler = createSupabaseAggregateEntities(
    'orders',
    v.object({}),
    'user'
  ) as unknown as (data: unknown, ctx: unknown) => Promise<{ value: unknown }>;
  return {
    calls,
    run: (data: unknown) => handler(data, { supabaseAdmin }),
  };
}

describe('createSupabaseAggregateEntities', () => {
  it('applies where filters after select', async () => {
    const { calls, run } = setup({ data: null, error: null, count: 3 });
    const res = await run({
      where: [['status', '==', 'paid']],
      aggregate: { field: 'id', operation: 'count' },
    });
    expect(res.value).toBe(3);
    expect(calls).toEqual([
      ['select', '*', { count: 'exact', head: true }],
      ['eq', 'status', 'paid'],
    ]);
  });

  it('sums a column over filtered rows', async () => {
    const { calls, run } = setup({
      data: [
        { total_amount: 10 },
        { total_amount: '5' },
        { total_amount: null },
      ],
      error: null,
      count: null,
    });
    const res = await run({
      where: [['amount', '>', 0]],
      aggregate: { field: 'totalAmount', operation: 'sum' },
    });
    expect(res.value).toBe(15);
    expect(calls[0]).toEqual(['select', 'total_amount']);
  });

  it('groups rows in JS for every operation', async () => {
    const rows = [
      { customer_id: 'a', status: 'paid', total: 10 },
      { customer_id: 'a', status: 'paid', total: 30 },
      { customer_id: 'b', status: 'paid', total: 5 },
      { customer_id: 'b', status: 'open', total: 7 },
    ];
    const { calls, run } = setup({ data: rows, error: null, count: null });

    const avg = await run({
      where: [['total', '>=', 0]],
      aggregate: { field: 'total', operation: 'avg' },
      groupBy: ['customerId', 'status'],
    });
    expect(avg.value).toEqual({ 'a|paid': 20, 'b|paid': 5, 'b|open': 7 });
    expect(calls[0]).toEqual(['select', 'customer_id, status, total']);
    expect(calls[1]).toEqual(['gte', 'total', 0]);

    const count = await run({
      aggregate: { field: 'id', operation: 'count' },
      groupBy: ['customerId'],
    });
    expect(count.value).toEqual({ a: 2, b: 2 });
  });

  it('throws on a query error', async () => {
    const { run } = setup({
      data: null,
      error: { message: 'boom' } as never,
      count: null,
    });
    await expect(
      run({ aggregate: { field: 'id', operation: 'count' } })
    ).rejects.toThrow(/boom/);
  });
});
