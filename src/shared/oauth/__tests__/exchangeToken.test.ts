// packages/functions/src/shared/oauth/__tests__/exchangeToken.test.ts

/**
 * @fileoverview Tests for exchangeTokenAlgorithm
 * @description Unit tests using dependency injection — no real OAuth or network calls.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { describe, it, expect, vi } from 'vitest';

import type {
  ExchangeTokenRequest,
  TokenResponse,
} from '@donotdev/core/server';

import { exchangeTokenAlgorithm, type OAuthProvider } from '../exchangeToken';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(result: TokenResponse): OAuthProvider {
  return {
    exchangeCodeForToken: vi.fn().mockResolvedValue(result),
  };
}

function makeRejectingProvider(error: Error): OAuthProvider {
  return {
    exchangeCodeForToken: vi.fn().mockRejectedValue(error),
  };
}

const BASE_REQUEST: ExchangeTokenRequest = {
  provider: 'github',
  purpose: 'login',
  code: 'auth-code-abc',
  redirectUri: 'https://app.example.com/oauth/callback',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('exchangeTokenAlgorithm', () => {
  describe('successful exchange', () => {
    it('returns token response from provider', async () => {
      const tokenResponse: TokenResponse = {
        access_token: 'access-token-xyz',
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: 'refresh-token-123',
      };
      const oauthProvider = makeProvider(tokenResponse);

      const result = await exchangeTokenAlgorithm(BASE_REQUEST, oauthProvider);

      expect(result).toEqual(tokenResponse);
    });

    it('forwards code, redirectUri, and codeVerifier to provider', async () => {
      const oauthProvider = makeProvider({
        access_token: 'tok',
      });
      const request: ExchangeTokenRequest = {
        ...BASE_REQUEST,
        codeVerifier: 'pkce-verifier-xyz',
      };

      await exchangeTokenAlgorithm(request, oauthProvider);

      expect(oauthProvider.exchangeCodeForToken).toHaveBeenCalledOnce();
      expect(oauthProvider.exchangeCodeForToken).toHaveBeenCalledWith({
        code: request.code,
        redirectUri: request.redirectUri,
        codeVerifier: 'pkce-verifier-xyz',
      });
    });

    it('forwards without codeVerifier when omitted', async () => {
      const oauthProvider = makeProvider({ access_token: 'tok' });

      await exchangeTokenAlgorithm(BASE_REQUEST, oauthProvider);

      expect(oauthProvider.exchangeCodeForToken).toHaveBeenCalledWith({
        code: BASE_REQUEST.code,
        redirectUri: BASE_REQUEST.redirectUri,
        codeVerifier: undefined,
      });
    });
  });

  describe('error scenarios', () => {
    it('re-throws errors from provider', async () => {
      const oauthProvider = makeRejectingProvider(new Error('invalid_grant'));

      await expect(
        exchangeTokenAlgorithm(BASE_REQUEST, oauthProvider)
      ).rejects.toThrow('invalid_grant');
    });

    it('calls provider exactly once on error', async () => {
      const oauthProvider = makeRejectingProvider(new Error('network error'));

      await expect(
        exchangeTokenAlgorithm(BASE_REQUEST, oauthProvider)
      ).rejects.toThrow('network error');

      expect(oauthProvider.exchangeCodeForToken).toHaveBeenCalledOnce();
    });
  });
});
