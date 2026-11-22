/**
 * @fileoverview Unit tests for `createListAuthUsers` (Supabase).
 * @description Runs the real `createSupabaseHandler`: a non-admin gets 403 and no
 *   listing; an admin gets every page of `auth.admin.listUsers`, mapped.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getUser = vi.fn();
const listUsers = vi.fn();

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => ({
    auth: { getUser, admin: { listUsers } },
  })),
}));

import { createListAuthUsers } from '../listAuthUsers.js';

const ENV = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SECRET_KEY: 'secret',
  DISABLE_RATE_LIMITING: 'true',
};

function request(): Request {
  return new Request(
    'https://example.supabase.co/functions/v1/list-auth-users',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer token',
        'content-type': 'application/json',
      },
      body: '{}',
    }
  );
}

function caller(role?: string) {
  getUser.mockResolvedValue({
    data: { user: { id: 'caller', app_metadata: role ? { role } : {} } },
    error: null,
  });
}

/** A GoTrue user; `n` makes ids unique. */
function authUser(n: number, extra: Record<string, unknown> = {}) {
  return {
    id: `u${n}`,
    email: `u${n}@example.com`,
    created_at: '2026-01-01T00:00:00Z',
    user_metadata: {},
    app_metadata: {},
    ...extra,
  };
}

function page(users: unknown[]) {
  return { data: { users, aud: 'authenticated' }, error: null };
}

describe('createListAuthUsers', () => {
  beforeEach(() => {
    getUser.mockReset();
    listUsers.mockReset();
    Object.assign(process.env, ENV);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    for (const key of Object.keys(ENV)) delete process.env[key];
    vi.restoreAllMocks();
  });

  it.each([undefined, 'user'])(
    'refuses a non-admin caller (role %s) with 403',
    async (role) => {
      caller(role);
      const res = await createListAuthUsers()(request());
      expect(res.status).toBe(403);
      expect(listUsers).not.toHaveBeenCalled();
    }
  );

  it('pages through every page (perPage 1000) until a short page', async () => {
    caller('admin');
    const full = Array.from({ length: 1000 }, (_, i) => authUser(i));
    listUsers
      .mockResolvedValueOnce(page(full))
      .mockResolvedValueOnce(page([authUser(1000)]));
    const res = await createListAuthUsers()(request());
    expect(res.status).toBe(200);
    const { users } = (await res.json()) as { users: { id: string }[] };
    expect(users).toHaveLength(1001);
    expect(users[1000]!.id).toBe('u1000');
    expect(listUsers.mock.calls).toEqual([
      [{ page: 1, perPage: 1000 }],
      [{ page: 2, perPage: 1000 }],
    ]);
  });

  it('maps the user (displayName: full_name, then name; nulls when absent)', async () => {
    caller('super');
    listUsers.mockResolvedValueOnce(
      page([
        authUser(1, {
          email_confirmed_at: '2026-01-02T00:00:00Z',
          last_sign_in_at: '2026-01-03T00:00:00Z',
          user_metadata: { full_name: 'Ana', name: 'ignored' },
        }),
        authUser(2, { email: undefined, user_metadata: { name: 'Bo' } }),
        authUser(3, { user_metadata: { full_name: 42 } }),
      ])
    );
    const res = await createListAuthUsers()(request());
    expect(await res.json()).toEqual({
      users: [
        {
          id: 'u1',
          email: 'u1@example.com',
          emailConfirmedAt: '2026-01-02T00:00:00Z',
          createdAt: '2026-01-01T00:00:00Z',
          lastSignInAt: '2026-01-03T00:00:00Z',
          displayName: 'Ana',
        },
        {
          id: 'u2',
          email: null,
          emailConfirmedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          lastSignInAt: null,
          displayName: 'Bo',
        },
        {
          id: 'u3',
          email: 'u3@example.com',
          emailConfirmedAt: null,
          createdAt: '2026-01-01T00:00:00Z',
          lastSignInAt: null,
          displayName: null,
        },
      ],
    });
  });

  it('fails (500, generic message) when Supabase returns an error', async () => {
    caller('admin');
    listUsers.mockResolvedValueOnce({
      data: { users: [] },
      error: new Error('db down'),
    });
    const res = await createListAuthUsers()(request());
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Internal server error' });
  });
});
