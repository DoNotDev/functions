/**
 * @fileoverview Unit tests for `createSupabaseUpdateEntity` validation.
 * @description Same rules as the client (createSchemas): a draft is checked whole
 *   against the draft schema, any other update checks what it writes against the
 *   update schema. The base handler wrapper is stubbed (inner logic called directly).
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

// Import after mocks so the update module picks them up.
import { createSchemas } from '@donotdev/core/server';

import { createSupabaseUpdateEntity } from '../crud/update.js';
import { contactEntity } from '@dndev/test-entities';

const schemas = createSchemas(contactEntity);

/** Stored row and a Supabase admin stub: select … single() reads it, update … single() writes it. */
let stored: Record<string, unknown> = {};
const updateSpy = vi.fn();
function chain(result: () => unknown) {
  const self: Record<string, unknown> = {};
  for (const method of ['select', 'eq', 'update']) {
    self[method] = (...args: unknown[]) => {
      if (method === 'update') updateSpy(args[0]);
      return self;
    };
  }
  self.single = async () => ({ data: result(), error: null });
  return self;
}
const supabaseAdmin = {
  from: () => chain(() => ({ id: 'c1', ...stored })),
};

const handler = createSupabaseUpdateEntity(
  'contacts',
  schemas.update as never,
  schemas.draft as never,
  'user'
) as unknown as (data: unknown, ctx: unknown) => Promise<unknown>;
const run = (payload: Record<string, unknown>) =>
  handler({ id: 'c1', payload }, { uid: 'u1', userRole: 'user', supabaseAdmin });

describe('createSupabaseUpdateEntity validation', () => {
  beforeEach(() => {
    updateSpy.mockClear();
  });

  it('non-draft: checks what the update writes against the update schema', async () => {
    // Legacy row with a required field empty: an update of another field passes
    stored = { name: null, status: 'available' };
    await expect(run({ phone: '+33 6 12 34 56 78' })).resolves.toBeDefined();
    for (const payload of [{ name: null }, { name: '' }, { phone: 'TOTO' }]) {
      await expect(run(payload)).rejects.toMatchObject({ code: 'invalid-argument' });
    }
    expect(updateSpy).toHaveBeenCalledTimes(1);
  });

  it('draft: required fields may be empty, filled ones keep their format', async () => {
    stored = { name: 'Ana', status: 'draft' };
    await expect(run({ name: null })).resolves.toBeDefined();
    await expect(run({ phone: 'TOTO' })).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  it('writes the parse output of the sent keys, never the raw payload', async () => {
    stored = { name: 'Ana', status: 'draft' };
    await run({ phone: '+33 6 12 34 56 78', createdById: 'evil', role: 'admin' });
    expect(updateSpy).toHaveBeenCalledTimes(1);
    const written = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.phone).toBe('+33 6 12 34 56 78');
    expect(written).not.toHaveProperty('role');
    // createdById is a backend name (write class never): only the metadata value may be present
    expect(written.createdById).not.toBe('evil');
    expect(written).not.toHaveProperty('name');
  });

  it('publishing a draft through a status-only patch checks the whole merged row', async () => {
    stored = { name: null, phone: null, status: 'draft' };
    await expect(run({ status: 'available' })).rejects.toMatchObject({ code: 'invalid-argument' });
    expect(updateSpy).not.toHaveBeenCalled();
    stored = { name: 'Ana', phone: null, status: 'draft' };
    await expect(run({ status: 'available' })).resolves.toBeDefined();
    const written = updateSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(written.status).toBe('available');
    expect(written).not.toHaveProperty('name');
  });

  it('soft-deleting a draft stays relaxed (deleted is hidden)', async () => {
    stored = { name: null, status: 'draft' };
    await expect(run({ status: 'deleted' })).resolves.toBeDefined();
  });
});
