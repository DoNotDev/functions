// packages/functions/src/firebase/oauth/refreshToken.ts

/**
 * @fileoverview OAuth token refresh Firebase function
 * @description Factory for the Firebase callable that refreshes OAuth tokens,
 * for the providers the app enables.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { CallableFunction } from 'firebase-functions/v2/https';

import {
  OAUTH_PARTNERS,
  type OAuthPartnerId,
  type OAuthRefreshRequest,
} from '@donotdev/core/server';
import {
  getFirebaseAdminFirestore,
  FieldValue,
} from '@donotdev/firebase/server';

import { assertAuthenticated } from '../../shared/utils/internal/auth.js';
import { defineOAuthProviderSecrets } from './providerSecrets.js';

/**
 * Create the callable that refreshes an OAuth token.
 *
 * Serves only `providers`: it declares `${PROVIDER}_CLIENT_SECRET` for each one
 * (bound at deploy) and rejects a request for any other provider with
 * `invalid-argument`. `${PROVIDER}_CLIENT_ID` stays plain config in functions/.env.
 *
 * @param providers - OAuth partner ids from `OAUTH_PARTNERS` (at least one)
 * @returns The `refreshToken` callable
 * @throws Error when `providers` is empty or lists an unknown provider
 *
 * @example
 * ```typescript
 * // functions/src/index.ts
 * import { createRefreshToken } from '@donotdev/functions/firebase';
 *
 * export const refreshToken = createRefreshToken(['github', 'google']);
 * ```
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createRefreshToken(
  providers: readonly OAuthPartnerId[]
): CallableFunction<
  OAuthRefreshRequest,
  ReturnType<typeof refreshTokenHandler>
> {
  const { allowed, secrets } = defineOAuthProviderSecrets(
    providers,
    'createRefreshToken'
  );
  return onCall<OAuthRefreshRequest>({ secrets }, (request) =>
    refreshTokenHandler(request.auth?.uid, request.data, allowed)
  );
}

/**
 * Refresh an OAuth token (enabled providers only).
 */
async function refreshTokenHandler(
  authUid: string | undefined,
  data: OAuthRefreshRequest,
  allowed: ReadonlySet<string>
) {
  // Verify authentication
  const uid = assertAuthenticated(authUid);

  const { provider, refreshToken: refreshTokenValue, redirectUri } = data;

  if (!allowed.has(provider)) {
    throw new HttpsError(
      'invalid-argument',
      `Provider ${provider} is not enabled`
    );
  }

  try {
    // Get provider endpoints
    const endpoints = OAUTH_PARTNERS[provider];
    if (!endpoints?.endpoints?.tokenUrl) {
      throw new HttpsError(
        'invalid-argument',
        `Provider ${provider} does not support token refresh`
      );
    }

    // Get client credentials: {PROVIDER}_CLIENT_ID, {PROVIDER}_CLIENT_SECRET
    const upper = provider.toUpperCase();
    const clientId = process.env[`${upper}_CLIENT_ID`];
    const clientSecret = process.env[`${upper}_CLIENT_SECRET`];

    if (!clientId || !clientSecret) {
      throw new HttpsError(
        'failed-precondition',
        `Provider ${provider} is not configured`
      );
    }

    // Refresh the token
    const response = await fetch(endpoints.endpoints.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshTokenValue,
        redirect_uri: redirectUri,
      }).toString(),
    });

    if (!response.ok) {
      const errorData = await response.text();
      console.error(`Token refresh error for ${provider}:`, errorData);
      throw new Error(
        `Failed to refresh token: ${response.status} ${response.statusText}`
      );
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: untrusted OAuth token response; needs a valibot schema (strict vs loose expires_in is an open owner decision)
    const tokenData = (await response.json()) as any;

    // Update the connection in Firestore
    const connectionRef = getFirebaseAdminFirestore()
      .collection('oauth_connections')
      .where('userId', '==', uid)
      .where('provider', '==', provider);

    const snapshot = await connectionRef.get();

    if (!snapshot.empty) {
      const connectionDoc = snapshot.docs[0];
      if (!connectionDoc) {
        throw new HttpsError(
          'not-found',
          'OAuth connection document not found'
        );
      }

      const connectionData = connectionDoc.data();
      if (!connectionData) {
        throw new HttpsError('internal', 'OAuth connection data is invalid');
      }

      const updatedCredentials = {
        ...connectionData.credentials,
        accessToken: tokenData.access_token,
        expiresAt: tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : connectionData.credentials.expiresAt,
        refreshToken:
          tokenData.refresh_token || connectionData.credentials.refreshToken,
      };

      await connectionDoc.ref.update({
        credentials: updatedCredentials,
        updatedAt: FieldValue.serverTimestamp(),
      });

      return {
        success: true,
        credentials: {
          accessToken: tokenData.access_token,
          refreshToken: tokenData.refresh_token,
          expiresAt: tokenData.expires_in
            ? Math.floor(Date.now() / 1000) + tokenData.expires_in
            : null,
          scope: tokenData.scope ? tokenData.scope.split(' ') : [],
        },
      };
    } else {
      throw new HttpsError('not-found', 'OAuth connection not found');
    }
  } catch (error) {
    console.error(`OAuth token refresh error for ${provider}:`, error);
    throw new HttpsError(
      'internal',
      error instanceof Error ? error.message : 'Failed to refresh token'
    );
  }
}
