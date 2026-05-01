import { describe, it, expect, vi, beforeEach } from 'vitest';

import { grantAccessAlgorithm, type OAuthGrantProvider } from '../grantAccess';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(result: {
  success: boolean;
  message: string;
}): OAuthGrantProvider {
  return { grantAccess: vi.fn().mockResolvedValue(result) };
}

function makeRejectingProvider(error: Error): OAuthGrantProvider {
  return { grantAccess: vi.fn().mockRejectedValue(error) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('grantAccessAlgorithm', () => {
  const userId = 'user-123';
  const provider = 'github';
  const accessToken = 'access-token-abc';
  const refreshToken = 'refresh-token-xyz';

  // -------------------------------------------------------------------------
  // Successful grant
  // -------------------------------------------------------------------------

  describe('successful grant', () => {
    it('returns success result from provider', async () => {
      const oauthProvider = makeProvider({ success: true, message: 'OK' });

      const result = await grantAccessAlgorithm(
        userId,
        provider,
        accessToken,
        refreshToken,
        oauthProvider
      );

      expect(result).toEqual({ success: true, message: 'OK' });
    });

    it('forwards all parameters to the provider', async () => {
      const oauthProvider = makeProvider({ success: true, message: 'granted' });

      await grantAccessAlgorithm(
        userId,
        provider,
        accessToken,
        refreshToken,
        oauthProvider
      );

      expect(oauthProvider.grantAccess).toHaveBeenCalledOnce();
      expect(oauthProvider.grantAccess).toHaveBeenCalledWith({
        userId,
        provider,
        accessToken,
        refreshToken,
      });
    });

    it('works without a refreshToken (undefined)', async () => {
      const oauthProvider = makeProvider({ success: true, message: 'granted' });

      const result = await grantAccessAlgorithm(
        userId,
        provider,
        accessToken,
        undefined,
        oauthProvider
      );

      expect(result.success).toBe(true);
      expect(oauthProvider.grantAccess).toHaveBeenCalledWith({
        userId,
        provider,
        accessToken,
        refreshToken: undefined,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Invalid / missing user
  // -------------------------------------------------------------------------

  describe('invalid / missing user', () => {
    it('passes empty userId to provider (provider owns validation)', async () => {
      const oauthProvider = makeProvider({
        success: false,
        message: 'user not found',
      });

      const result = await grantAccessAlgorithm(
        '',
        provider,
        accessToken,
        undefined,
        oauthProvider
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('user not found');
      expect(oauthProvider.grantAccess).toHaveBeenCalledWith({
        userId: '',
        provider,
        accessToken,
        refreshToken: undefined,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Permission checks (provider denies access)
  // -------------------------------------------------------------------------

  describe('permission checks', () => {
    it('returns provider failure when access is denied', async () => {
      const oauthProvider = makeProvider({
        success: false,
        message: 'permission denied',
      });

      const result = await grantAccessAlgorithm(
        userId,
        provider,
        accessToken,
        refreshToken,
        oauthProvider
      );

      expect(result.success).toBe(false);
      expect(result.message).toBe('permission denied');
    });

    it('propagates the exact message returned by the provider', async () => {
      const expectedMessage = 'scope insufficient for this resource';
      const oauthProvider = makeProvider({
        success: false,
        message: expectedMessage,
      });

      const result = await grantAccessAlgorithm(
        userId,
        provider,
        accessToken,
        refreshToken,
        oauthProvider
      );

      expect(result.message).toBe(expectedMessage);
    });
  });

  // -------------------------------------------------------------------------
  // Provider-specific grant logic
  // -------------------------------------------------------------------------

  describe('provider-specific grant logic', () => {
    it.each([
      ['github', 'gh-token'],
      ['google', 'goog-token'],
      ['stripe', 'stripe-token'],
    ])(
      'correctly forwards provider "%s" with its access token',
      async (providerName, token) => {
        const oauthProvider = makeProvider({
          success: true,
          message: 'granted',
        });

        await grantAccessAlgorithm(
          userId,
          providerName,
          token,
          undefined,
          oauthProvider
        );

        expect(oauthProvider.grantAccess).toHaveBeenCalledWith(
          expect.objectContaining({
            provider: providerName,
            accessToken: token,
          })
        );
      }
    );
  });

  // -------------------------------------------------------------------------
  // Error scenarios
  // -------------------------------------------------------------------------

  describe('error scenarios', () => {
    it('re-throws synchronous errors from provider', async () => {
      const oauthProvider = makeRejectingProvider(new Error('network failure'));

      await expect(
        grantAccessAlgorithm(
          userId,
          provider,
          accessToken,
          refreshToken,
          oauthProvider
        )
      ).rejects.toThrow('network failure');
    });

    it('re-throws custom provider errors without wrapping', async () => {
      class ProviderError extends Error {
        constructor(msg: string) {
          super(msg);
          this.name = 'ProviderError';
        }
      }

      const originalError = new ProviderError('token expired');
      const oauthProvider = makeRejectingProvider(originalError);

      await expect(
        grantAccessAlgorithm(
          userId,
          provider,
          accessToken,
          refreshToken,
          oauthProvider
        )
      ).rejects.toThrow('token expired');
    });

    it('calls provider exactly once even on error', async () => {
      const oauthProvider = makeRejectingProvider(new Error('boom'));

      await expect(
        grantAccessAlgorithm(
          userId,
          provider,
          accessToken,
          refreshToken,
          oauthProvider
        )
      ).rejects.toThrow('boom');

      expect(oauthProvider.grantAccess).toHaveBeenCalledOnce();
    });
  });
});
