// packages/functions/src/firebase/oauth/refreshToken.ts

/**
 * @fileoverview OAuth token refresh Firebase function
 * @description Firebase callable function for refreshing OAuth tokens
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';

import {
  OAUTH_PARTNERS,
  type OAuthRefreshRequest,
} from '@donotdev/core/server';
import {
  getFirebaseAdminFirestore,
  FieldValue,
} from '@donotdev/firebase/server';

import { assertAuthenticated } from '../../shared/utils.js';

/**
 * Refresh an OAuth token
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const refreshToken = onCall<OAuthRefreshRequest>(async (request) => {
  // Verify authentication
  const uid = assertAuthenticated(request.auth);

  const {
    provider,
    refreshToken: refreshTokenValue,
    redirectUri,
  } = request.data;

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
});
