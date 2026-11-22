// packages/functions/src/firebase/oauth/__tests__/tokenFactories.test.ts

/**
 * @fileoverview OAuth token callables are built per enabled provider list
 * @description `createExchangeToken` / `createRefreshToken` declare
 * `${PROVIDER}_CLIENT_SECRET` for exactly the listed providers, fail at
 * creation on an unknown or empty list, and reject requests for any other
 * provider with `invalid-argument`.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: vi.fn(() => {
    throw new Error('Firestore must not be reached for a rejected provider');
  }),
  FieldValue: {},
}));

import type { OAuthPartnerId } from '@donotdev/core/server';

import { createExchangeToken } from '../exchangeToken';
import { createRefreshToken } from '../refreshToken';

/** Secret names a built function declares. */
function declared(fn: {
  __endpoint: { secretEnvironmentVariables?: Array<{ key: string }> };
}): string[] {
  return (fn.__endpoint.secretEnvironmentVariables ?? []).map((s) => s.key);
}

const auth = { uid: 'user-1', token: {}, rawToken: 'raw' };

describe.each([
  ['createExchangeToken', createExchangeToken],
  ['createRefreshToken', createRefreshToken],
] as const)('%s', (name, factory) => {
  it('declares the client secret of exactly the listed providers', () => {
    const fn = factory(['github', 'google', 'github']);
    expect(declared(fn)).toEqual([
      'GITHUB_CLIENT_SECRET',
      'GOOGLE_CLIENT_SECRET',
    ]);
    expect(declared(fn)).not.toContain('GITHUB_CLIENT_ID');
  });

  it('fails at creation on an unknown provider', () => {
    expect(() => factory(['github', 'nope' as OAuthPartnerId])).toThrow(
      `${name}: unknown OAuth provider "nope"`
    );
  });

  it('fails at creation on an empty provider list', () => {
    expect(() => factory([])).toThrow(
      `${name}: providers is required and must list at least one OAuth provider`
    );
  });
});

describe('requests for a provider that is not listed', () => {
  it('exchangeToken rejects them with invalid-argument', async () => {
    const fn = createExchangeToken(['github']);
    await expect(
      fn.run({
        auth,
        data: {
          provider: 'google',
          purpose: 'signin',
          code: 'code',
          redirectUri: 'https://app.example/callback',
        },
        rawRequest: {},
        acceptsStreaming: false,
      } as unknown as Parameters<typeof fn.run>[0])
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Provider google is not enabled',
    });
  });

  it('refreshToken rejects them with invalid-argument', async () => {
    const fn = createRefreshToken(['github']);
    await expect(
      fn.run({
        auth,
        data: {
          provider: 'google',
          refreshToken: 'refresh',
          redirectUri: 'https://app.example/callback',
        },
        rawRequest: {},
        acceptsStreaming: false,
      } as unknown as Parameters<typeof fn.run>[0])
    ).rejects.toMatchObject({
      code: 'invalid-argument',
      message: 'Provider google is not enabled',
    });
  });
});
