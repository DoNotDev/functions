// packages/functions/src/firebase/oauth/exchangeToken.ts

/**
 * @fileoverview OAuth token exchange Firebase function
 * @description Firebase callable function for exchanging OAuth codes for tokens
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';

import {
  OAUTH_PARTNERS,
  type ExchangeTokenRequest,
  type OAuthPartnerId,
} from '@donotdev/core/server';
import {
  getFirebaseAdminFirestore,
  FieldValue,
} from '@donotdev/firebase/server';

import { assertAuthenticated } from '../../shared/utils.js';

/**
 * Exchange OAuth authorization code for access token
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const exchangeToken = onCall<ExchangeTokenRequest>(async (request) => {
  // Verify authentication
  const uid = assertAuthenticated(request.auth);

  const { provider, purpose, code, redirectUri, codeVerifier, idempotencyKey } =
    request.data;

  // W17: Validate idempotency key length and content.
  if (idempotencyKey !== undefined) {
    if (
      typeof idempotencyKey !== 'string' ||
      idempotencyKey.length === 0 ||
      idempotencyKey.length > 256
    ) {
      throw new HttpsError(
        'invalid-argument',
        'idempotencyKey must be a non-empty string of at most 256 characters'
      );
    }
    if (!/^[\w\-.:@]+$/.test(idempotencyKey)) {
      throw new HttpsError(
        'invalid-argument',
        'idempotencyKey contains invalid characters'
      );
    }
  }

  // Validate required parameters BEFORE reserving idempotency key
  if (!provider || !purpose || !code || !redirectUri) {
    throw new HttpsError('invalid-argument', 'Missing required parameters');
  }

  // C9: Atomic idempotency check using Firestore transaction to prevent TOCTOU race.
  // A concurrent request with the same key would see the 'pending' sentinel and wait
  // or return early instead of executing duplicate business logic.
  if (idempotencyKey) {
    const db = getFirebaseAdminFirestore();
    const idempotencyRef = db
      .collection('idempotency')
      .doc(`oauth_${idempotencyKey}`);

    let existingResult: unknown = undefined;
    let alreadyProcessed = false;

    await db.runTransaction(async (tx) => {
      const idempotencyDoc = await tx.get(idempotencyRef);
      if (idempotencyDoc.exists) {
        existingResult = idempotencyDoc.data()?.result;
        alreadyProcessed = true;
        return;
      }
      // Reserve the key before executing business logic
      tx.set(idempotencyRef, {
        processing: true,
        reservedAt: new Date().toISOString(),
      });
    });

    if (alreadyProcessed) {
      return existingResult;
    }
  }

  try {
    // Get provider endpoints
    const endpoints = OAUTH_PARTNERS[provider];
    if (!endpoints) {
      throw new HttpsError(
        'invalid-argument',
        `Provider ${provider} is not supported`
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

    // Exchange code for token
    const tokenResponse = await fetch(endpoints.endpoints.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        code,
        redirect_uri: redirectUri,
        ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
      }).toString(),
    });

    if (!tokenResponse.ok) {
      const errorData = await tokenResponse.text();
      console.error(
        `Token exchange error for ${provider}: ${tokenResponse.status} ${tokenResponse.statusText}`
      );
      throw new Error(
        `Failed to exchange code for token: ${tokenResponse.status} ${tokenResponse.statusText}`
      );
    }

    const tokenData = (await tokenResponse.json()) as any;

    // Format the credentials
    const credentials = {
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || null,
      expiresAt: tokenData.expires_in
        ? Math.floor(Date.now() / 1000) + tokenData.expires_in
        : null,
      idToken: tokenData.id_token || null,
      scope: tokenData.scope ? tokenData.scope.split(' ') : [],
    };

    // Get user profile from provider
    let profile = null;
    if (credentials.accessToken) {
      profile = await fetchUserProfile(provider, credentials.accessToken);
    }

    // Save connection to Firestore
    await saveOAuthConnection({
      uid,
      provider,
      purpose,
      credentials,
      profile,
    });

    const result = {
      success: true,
      credentials,
      profile,
    };

    // Store result for idempotency if key provided
    if (idempotencyKey) {
      const db = getFirebaseAdminFirestore();
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`oauth_${idempotencyKey}`);
      await idempotencyRef.set({
        result,
        processedAt: new Date().toISOString(),
        processedBy: uid,
      });
    }

    return result;
  } catch (error) {
    console.error(
      `OAuth token exchange error for ${provider}:`,
      error instanceof Error ? error.message : 'Unknown error'
    );
    throw new HttpsError(
      'internal',
      error instanceof Error
        ? error.message
        : 'Failed to exchange code for token'
    );
  }
});

/**
 * Fetch user profile from OAuth provider
 */
async function fetchUserProfile(
  provider: string,
  accessToken: string
): Promise<any> {
  try {
    const endpoints = OAUTH_PARTNERS[provider as OAuthPartnerId];
    if (!endpoints?.endpoints?.profileUrl) {
      return null;
    }

    const response = await fetch(endpoints.endpoints.profileUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      console.warn(`Failed to fetch profile for ${provider}:`, response.status);
      return null;
    }

    return await response.json();
  } catch (error) {
    console.error(`Error fetching profile for ${provider}:`, error);
    return null;
  }
}

/**
 * Save OAuth connection to Firestore
 */
async function saveOAuthConnection(data: {
  uid: string;
  provider: string;
  purpose: string;
  credentials: any;
  profile: any;
}): Promise<void> {
  try {
    const connectionRef = getFirebaseAdminFirestore()
      .collection('oauth_connections')
      .where('userId', '==', data.uid)
      .where('provider', '==', data.provider)
      .where('purpose', '==', data.purpose);

    const snapshot = await connectionRef.get();

    const connectionData = {
      userId: data.uid,
      provider: data.provider,
      purpose: data.purpose,
      credentials: data.credentials,
      profile: data.profile,
      connected: true,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      lastUsed: FieldValue.serverTimestamp(),
    };

    if (snapshot.empty) {
      // Create new connection
      await getFirebaseAdminFirestore()
        .collection('oauth_connections')
        .add(connectionData);
    } else {
      // Update existing connection
      const existingDoc = snapshot.docs[0];
      if (existingDoc) {
        await existingDoc.ref.update({
          ...connectionData,
          createdAt: existingDoc.data()?.createdAt, // Preserve original creation time
        });
      }
    }
  } catch (error) {
    console.error('Error saving OAuth connection:', error);
    throw error;
  }
}
