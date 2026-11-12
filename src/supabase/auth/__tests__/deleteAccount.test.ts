/**
 * @fileoverview Unit tests for `createDeleteAccount`.
 * @description `beforeDelete` runs first; a throw refuses the deletion with a 409
 *   carrying the error's message and code, and the auth user is kept.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../baseFunction.js', () => ({
  createSupabaseHandler: vi.fn(
    (_operationName: string, _schema: unknown, handler: any) => handler
  ),
}));

import { createDeleteAccount } from '../deleteAccount.js';

type Handler = (data: unknown, ctx: unknown) => Promise<unknown>;

function setup(deleteError: unknown = null) {
  const order: string[] = [];
  const deleteUser = vi.fn(async () => {
    order.push('deleteUser');
    return { error: deleteError };
  });
  const ctx = {
    uid: 'user-1',
    userRole: 'user',
    supabaseAdmin: { auth: { admin: { deleteUser } } },
  };
  return { ctx, deleteUser, order };
}

describe('createDeleteAccount', () => {
  it('deletes the caller without options (unchanged behaviour)', async () => {
    const { ctx, deleteUser } = setup();
    const handler = createDeleteAccount() as unknown as Handler;
    await expect(handler({}, ctx)).resolves.toEqual({ success: true });
    expect(deleteUser).toHaveBeenCalledWith('user-1');
  });

  it('runs beforeDelete with the context before deleting the user', async () => {
    const { ctx, deleteUser, order } = setup();
    const beforeDelete = vi.fn(async (c: unknown) => {
      expect(c).toBe(ctx);
      order.push('beforeDelete');
    });
    const handler = createDeleteAccount({ beforeDelete }) as unknown as Handler;
    await expect(handler({}, ctx)).resolves.toEqual({ success: true });
    expect(order).toEqual(['beforeDelete', 'deleteUser']);
    expect(deleteUser).toHaveBeenCalledTimes(1);
  });

  it('refuses with 409 { error, code } and keeps the user when beforeDelete throws', async () => {
    const { ctx, deleteUser } = setup();
    const refusal = Object.assign(new Error('open_orders'), { code: 'P0001' });
    const handler = createDeleteAccount({
      beforeDelete: async () => {
        throw refusal;
      },
    }) as unknown as Handler;
    const res = (await handler({}, ctx)) as Response;
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'open_orders', code: 'P0001' });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('refuses an error without a code with its message only', async () => {
    const { ctx, deleteUser } = setup();
    const handler = createDeleteAccount({
      beforeDelete: async () => {
        throw new Error('unpaid_terms');
      },
    }) as unknown as Handler;
    const res = (await handler({}, ctx)) as Response;
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'unpaid_terms' });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('refuses a plain-object rejection (PostgREST { message, code } shape)', async () => {
    const { ctx, deleteUser } = setup();
    const handler = createDeleteAccount({
      beforeDelete: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- why: PostgREST rejects with plain objects
        throw { message: 'open_orders', code: 'P0001', details: null };
      },
    }) as unknown as Handler;
    const res = (await handler({}, ctx)) as Response;
    expect(await res.json()).toEqual({ error: 'open_orders', code: 'P0001' });
    expect(deleteUser).not.toHaveBeenCalled();
  });

  it('throws when Supabase fails to delete the user', async () => {
    const failure = new Error('db down');
    const { ctx } = setup(failure);
    const handler = createDeleteAccount({
      beforeDelete: async () => {},
    }) as unknown as Handler;
    await expect(handler({}, ctx)).rejects.toBe(failure);
  });
});
