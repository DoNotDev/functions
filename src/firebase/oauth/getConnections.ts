// packages/functions/src/firebase/oauth/getConnections.ts

/**
 * @fileoverview Get OAuth connections Firebase function
 * @description Firebase callable function for retrieving user OAuth connections
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { onCall, HttpsError } from 'firebase-functions/v2/https';

import type { OAuthPurpose } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { assertAuthenticated } from '../../shared/utils.js';

/**
 * Get a user's OAuth connections
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const getConnections = onCall<{ purpose?: OAuthPurpose }>(
  async (request) => {
    // Verify authentication
    const uid = assertAuthenticated(request.auth);

    const { purpose } = request.data || {};

    try {
      // Query Firestore for user's connections
      const connectionsRef = getFirebaseAdminFirestore()
        .collection('oauth_connections')
        .where('userId', '==', uid);

      // Apply purpose filter if provided
      const query = purpose
        ? connectionsRef.where('purpose', '==', purpose)
        : connectionsRef;

      const snapshot = await query.get();

      // Format connections
      const connections = snapshot.docs.map((doc: any) => {
        const data = doc.data();

        // Check if the token is expired
        const isExpired = data.credentials?.expiresAt
          ? data.credentials.expiresAt < Math.floor(Date.now() / 1000)
          : false;

        return {
          id: doc.id,
          userId: data.userId,
          provider: data.provider,
          purpose: data.purpose,
          connected: !isExpired,
          createdAt: data.createdAt?.toDate?.()
            ? data.createdAt.toDate().toISOString()
            : data.createdAt,
          updatedAt: data.updatedAt?.toDate?.()
            ? data.updatedAt.toDate().toISOString()
            : data.updatedAt,
          lastUsed: data.lastUsed?.toDate?.()
            ? data.lastUsed.toDate().toISOString()
            : data.lastUsed,
          // Only expose connection status, not raw tokens — credentials stay server-side
          hasCredentials: !isExpired && !!data.credentials,
          profile: data.profile,
        };
      });

      return { connections };
    } catch (error) {
      console.error('Error getting OAuth connections:', error);
      throw new HttpsError(
        'internal',
        error instanceof Error ? error.message : 'Failed to get connections'
      );
    }
  }
);
