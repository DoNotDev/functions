// packages/functions/src/firebase/oauth/disconnect.ts

/**
 * @fileoverview OAuth disconnect Firebase function
 * @description Firebase callable function for disconnecting OAuth providers
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';

import { OAUTH_PARTNERS } from '@donotdev/core/server';
import type { OAuthPartnerId, OAuthPurpose } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { assertAuthenticated } from '../../shared/utils.js';

/**
 * Disconnect a provider
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const disconnect = onCall<{
  provider: OAuthPartnerId;
  purpose: OAuthPurpose;
}>(async (request) => {
  // Verify authentication
  const uid = assertAuthenticated(request.auth);

  const { provider, purpose } = request.data;

  try {
    // Find the connection to disconnect
    const connectionRef = getFirebaseAdminFirestore()
      .collection('oauth_connections')
      .where('userId', '==', uid)
      .where('provider', '==', provider)
      .where('purpose', '==', purpose);

    const snapshot = await connectionRef.get();

    if (snapshot.empty) {
      throw new HttpsError('not-found', 'Connection not found');
    }

    const connectionDoc = snapshot.docs[0];
    if (!connectionDoc) {
      throw new HttpsError('not-found', 'Connection not found');
    }
    const connectionData = connectionDoc.data();

    // Revoke the token if possible
    if (connectionData?.credentials?.accessToken) {
      try {
        await revokeToken(provider, connectionData.credentials.accessToken);
      } catch (revokeError) {
        console.warn(`Failed to revoke token for ${provider}:`, revokeError);
        // Continue with disconnection even if revoke fails
      }
    }

    // Delete the connection
    await connectionDoc.ref.delete();

    return { success: true };
  } catch (error) {
    console.error(`Error disconnecting ${provider}:`, error);
    throw new HttpsError(
      'internal',
      error instanceof Error ? error.message : 'Failed to disconnect'
    );
  }
});

/**
 * Revoke OAuth token
 */
async function revokeToken(
  provider: string,
  accessToken: string
): Promise<void> {
  try {
    const endpoints = OAUTH_PARTNERS[provider as OAuthPartnerId];
    const revokeUrl = 'revokeUrl' in endpoints ? endpoints.revokeUrl : null;
    if (!revokeUrl) {
      return;
    }

    const response = await fetch(revokeUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        token: accessToken,
      }).toString(),
    });

    if (!response.ok) {
      console.warn(`Failed to revoke token for ${provider}:`, response.status);
    }
  } catch (error) {
    console.error(`Error revoking token for ${provider}:`, error);
  }
}
