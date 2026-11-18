/**
 * @fileoverview Unit tests for `createSupabaseCreateEntity`: status rule
 * (`DEFAULT_STATUS_VALUE`, `writeSchemaFor`) and parse-output inserts. The base
 * handler wrapper is stubbed (inner logic called directly).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../baseFunction.js', () => ({
  createSupabaseHandler: vi.fn(
    (_operationName: string, _schema: unknown, handler: unknown) => handler
  ),
}));

vi.mock('@donotdev/supabase/server', () => ({
  defaultFieldMapper: {
    toBackendField: (f: string) => f,
    toBackendKeys: (o: Record<string, unknown>) => o,
    fromBackendRow: (r: Record<string, unknown>) => r,
  },
}));

// Import after mocks so the create module picks them up.
import { createSchemas } from '@donotdev/core/server';

import { createSupabaseCreateEntity } from '../crud/create.js';
import { contactEntity } from '@dndev/test-entities';

const schemas = createSchemas(contactEntity);

/** Supabase admin stub: insert … single() returns the inserted row. */
const insertSpy = vi.fn();
const supabaseAdmin = {
  from: () => {
    let row: Record<string, unknown> = {};
    const self: Record<string, unknown> = {
      insert: (r: Record<string, unknown>) => {
        insertSpy(r);
        row = r;
        return self;
      },
      select: () => self,
      single: async () => ({ data: { id: 'n1', ...row }, error: null }),
    };
    return self;
  },
};

const handler = createSupabaseCreateEntity(
  'contacts',
  schemas.create as never,
  schemas.draft as never,
  'user'
) as unknown as (data: unknown, ctx: unknown) => Promise<unknown>;
const run = (payload: Record<string, unknown>) =>
  handler({ payload }, { uid: 'u1', userRole: 'user', supabaseAdmin });
const inserted = (): Record<string, unknown> =>
  insertSpy.mock.calls.at(-1)![0] as Record<string, unknown>;

describe('createSupabaseCreateEntity status rule and writes', () => {
  beforeEach(() => {
    insertSpy.mockClear();
  });

  it('a create without status is published (DEFAULT_STATUS_VALUE) and validated as a create', async () => {
    await expect(run({ phone: '+33 6 12 34 56 78' })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(insertSpy).not.toHaveBeenCalled();
    await run({ name: 'Ana' });
    expect(inserted().status).toBe('available');
  });

  it('a draft is validated with the draft schema', async () => {
    await run({ status: 'draft', name: null });
    expect(inserted().status).toBe('draft');
    await expect(run({ status: 'draft', phone: 'TOTO' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('inserts the parse output: unknown, hidden and generated keys never reach the table', async () => {
    await run({ name: 'Ana', secret: 's', role: 'admin', createdById: 'evil', createdAt: 'x' });
    const row = inserted();
    expect(row).not.toHaveProperty('secret');
    expect(row).not.toHaveProperty('role');
    expect(row.createdAt).not.toBe('x');
    expect(row.createdById).toBe('u1');
  });
});
