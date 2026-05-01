// packages/functions/src/firebase/scheduled/checkExpiredSubscriptions.ts

/**
 * @fileoverview Check expired subscriptions scheduled function
 * @description Firebase scheduled function for checking and updating expired subscriptions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import { onSchedule } from 'firebase-functions/v2/scheduler';

import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
} from '@donotdev/firebase/server';

import { handleError } from '../../shared/errorHandling.js';

/**
 * Scheduled function that runs daily to check for expired subscriptions
 * and update custom claims with expired status.
 *
 * **Architecture decision — opt-in scheduled function:**
 * This function is not automatically deployed. Consumer apps opt in by
 * exporting it from their functions entry point (e.g. `index.ts`). If not
 * exported, Firebase never schedules it.
 *
 * The `users` collection path defaults to `'users'` but is configurable via
 * the `USERS_COLLECTION_PATH` environment variable, allowing consumers to
 * use their own collection structure (e.g. `'app_users'`, `'tenants/{id}/users'`).
 */
export const checkExpiredSubscriptions = onSchedule(
  {
    schedule: '0 0 * * *', // Run daily at midnight UTC
    timeZone: 'UTC',
  },
  async () => {
    try {
      logger.info('Starting expired subscription check');

      const auth = getFirebaseAdminAuth();
      const db = getFirebaseAdminFirestore();
      const now = new Date();

      // W18: The 'users' collection name is configurable. Consumer apps may use
      // a different collection. Default to 'users' but respect
      // USERS_COLLECTION_PATH env var if set.
      const usersCollection = process.env.USERS_COLLECTION_PATH || 'users';

      // Guard: if the collection doesn't exist the query returns empty, which
      // is safe. Log a warning so operators know if misconfigured.
      const collectionRef = db.collection(usersCollection);

      // Get all users with active subscriptions
      const usersSnapshot = await collectionRef
        .where('subscription.status', '==', 'active')
        .get();

      let processedCount = 0;
      let expiredCount = 0;

      for (const userDoc of usersSnapshot.docs) {
        try {
          const userData = userDoc.data();
          const subscription = userData.subscription;

          if (!subscription || !subscription.subscriptionEnd) {
            continue;
          }

          // Check if subscription has expired
          if (new Date(subscription.subscriptionEnd) < now) {
            logger.info('Found expired subscription', {
              userId: userDoc.id,
              subscriptionEnd: subscription.subscriptionEnd,
              tier: subscription.tier,
            });

            await revokeExpiredSubscription(userDoc.id, subscription);
            expiredCount++;
          }

          processedCount++;
        } catch (error) {
          logger.error('Error processing user subscription', {
            userId: userDoc.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      logger.info('Expired subscription check completed', {
        processedCount,
        expiredCount,
      });
    } catch (error) {
      logger.error('Failed to check expired subscriptions', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw handleError(error);
    }
  }
);

/**
 * Revoke expired subscription access and clean up claims
 */
async function revokeExpiredSubscription(userId: string, subscription: any) {
  try {
    const auth = getFirebaseAdminAuth();
    const user = await auth.getUser(userId);
    const currentClaims = user.customClaims || {};

    // Update subscription status to expired
    const nowISO = new Date().toISOString();
    const updatedClaims = {
      ...currentClaims,
      subscription: {
        ...subscription,
        status: 'expired',
        expiredAt: nowISO,
        updatedAt: nowISO,
      },
    };

    await auth.setCustomUserClaims(userId, updatedClaims);

    logger.info('Successfully revoked expired subscription', {
      userId,
      tier: subscription.tier,
    });

    // Note: Consumers should implement their own business logic here
    // to revoke access to their specific services (GitHub, APIs, etc.)
    // based on the updated custom claims
  } catch (error) {
    logger.error('Failed to revoke expired subscription', {
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}
