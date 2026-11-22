// packages/functions/src/firebase/oauth/exchangeToken.ts

/**
 * @fileoverview OAuth token exchange Firebase function
 * @description Factory for the Firebase callable that exchanges OAuth codes for
 * tokens, for the providers the app enables.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import type { CallableFunction } from 'firebase-functions/v2/https';

import {
  OAUTH_PARTNERS,
  type ExchangeTokenRequest,
  type OAuthPartnerId,
} from '@donotdev/core/server';
import {
  getFirebaseAdminFirestore,
  FieldValue,
} from '@donotdev/firebase/server';

import { assertAuthenticated } from '../../shared/utils/internal/auth.js';
import { defineOAuthProviderSecrets } from './providerSecrets.js';

/**
 * Create the callable that exchanges an OAuth authorization code for tokens.
 *
 * Serves only `providers`: it declares `${PROVIDER}_CLIENT_SECRET` for each one
 * (bound at deploy) and rejects a request for any other provider with
 * `invalid-argument`. `${PROVIDER}_CLIENT_ID` stays plain config in functions/.env.
 *
 * @param providers - OAuth partner ids from `OAUTH_PARTNERS` (at least one)
 * @returns The `exchangeToken` callable
 * @throws Error when `providers` is empty or lists an unknown provider
 *
 * @example
 * ```typescript
 * // functions/src/index.ts
 * import { createExchangeToken } from '@donotdev/functions/firebase';
 *
 * export const exchangeToken = createExchangeToken(['github', 'google']);
 * ```
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createExchangeToken(
  providers: readonly OAuthPartnerId[]
): CallableFunction<ExchangeTokenRequest, Promise<unknown>> {
  const { allowed, secrets } = defineOAuthProviderSecrets(
    providers,
    'createExchangeToken'
  );
  return onCall<ExchangeTokenRequest>({ secrets }, (request) =>
    exchangeTokenHandler(request.auth?.uid, request.data, allowed)
  );
}

/**
 * Exchange OAuth authorization code for access token (enabled providers only).
 */
async function exchangeTokenHandler(
  authUid: string | undefined,
  data: ExchangeTokenRequest,
  allowed: ReadonlySet<string>
): Promise<unknown> {
  // Verify authentication
  const uid = assertAuthenticated(authUid);

  const { provider, purpose, code, redirectUri, codeVerifier, idempotencyKey } =
    data;

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

  if (!allowed.has(provider)) {
    throw new HttpsError(
      'invalid-argument',
      `Provider ${provider} is not enabled`
    );
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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: untrusted OAuth token response; needs a valibot schema (strict vs loose expires_in is an open owner decision)
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
}

/**
 * Fetch user profile from OAuth provider
 */
async function fetchUserProfile(
  provider: string,
  accessToken: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: not yet narrowed (any-audit 2026-11-11 follow-up)
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: not yet narrowed (any-audit 2026-11-11 follow-up)
  credentials: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: not yet narrowed (any-audit 2026-11-11 follow-up)
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
