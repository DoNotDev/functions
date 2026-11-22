/**
 * @fileoverview Unit tests for `listAuthUsers` (Firebase).
 * @description Runs the real `createBaseFunction`: a non-admin is refused and
 *   nothing is listed; an admin gets every page of Admin SDK
 *   `listUsers`, mapped to `AuthUserSummary`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('firebase-functions/v2', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
}));

vi.mock('firebase-functions/v2/https', () => {
  class HttpsError extends Error {
    constructor(
      public code: string,
      message: string,
      public details?: unknown
    ) {
      super(message);
    }
  }
  // onCall returns the raw handler so the test calls it with a request
  return {
    onCall: (_config: unknown, handler: unknown) => handler,
    HttpsError,
  };
});

const listUsers = vi.fn();
vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: () => ({ listUsers }),
}));

import { listAuthUsers } from '../listAuthUsers.js';

type Callable = (request: unknown) => Promise<unknown>;

function call(role?: string) {
  const handler = listAuthUsers() as unknown as Callable;
  return handler({
    auth: { uid: 'caller', token: role ? { role } : {} },
    data: {},
    app: {},
    rawRequest: { headers: {} },
  });
}

/** A Firebase UserRecord; `n` makes uids unique. */
function record(n: number, extra: Record<string, unknown> = {}) {
  return {
    uid: `u${n}`,
    email: `u${n}@example.com`,
    emailVerified: false,
    metadata: {
      creationTime: 'Thu, 01 Jan 2026 00:00:00 GMT',
      lastSignInTime: null,
    },
    ...extra,
  };
}

describe('listAuthUsers (Firebase)', () => {
  beforeEach(() => {
    listUsers.mockReset();
    process.env.DISABLE_RATE_LIMITING = 'true';
  });
  afterEach(() => {
    delete process.env.DISABLE_RATE_LIMITING;
  });

  it.each([undefined, 'user'])(
    'refuses a non-admin caller (role %s)',
    async (role) => {
      // createBaseFunction's role refusal (plain "Access denied" Error) reaches the
      // client through handleError, which classifies it as `internal` today.
      await expect(call(role)).rejects.toThrow();
      expect(listUsers).not.toHaveBeenCalled();
    }
  );

  it('pages with the page token (1000 per page) until there is none', async () => {
    listUsers
      .mockResolvedValueOnce({ users: [record(1)], pageToken: 'next' })
      .mockResolvedValueOnce({ users: [record(2)] });
    const result = (await call('admin')) as { users: { id: string }[] };
    expect(result.users.map((u) => u.id)).toEqual(['u1', 'u2']);
    expect(listUsers.mock.calls).toEqual([
      [1000, undefined],
      [1000, 'next'],
    ]);
  });

  it('maps the record (ISO dates; verified address carries the creation time)', async () => {
    listUsers.mockResolvedValueOnce({
      users: [
        record(1, {
          emailVerified: true,
          displayName: 'Ana',
          metadata: {
            creationTime: 'Thu, 01 Jan 2026 00:00:00 GMT',
            lastSignInTime: 'Sat, 03 Jan 2026 00:00:00 GMT',
          },
        }),
        record(2, { email: undefined }),
      ],
    });
    expect(await call('super')).toEqual({
      users: [
        {
          id: 'u1',
          email: 'u1@example.com',
          emailConfirmedAt: '2026-01-01T00:00:00.000Z',
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSignInAt: '2026-01-03T00:00:00.000Z',
          displayName: 'Ana',
        },
        {
          id: 'u2',
          email: null,
          emailConfirmedAt: null,
          createdAt: '2026-01-01T00:00:00.000Z',
          lastSignInAt: null,
          displayName: null,
        },
      ],
    });
  });
});
