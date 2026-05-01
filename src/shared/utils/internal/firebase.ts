// packages/functions/src/shared/utils/internal/firebase.ts

/**
 * @fileoverview Firebase initialization utilities
 * @description Re-exports provider functions for DRY access
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { getFirebaseAdminApp } from '@donotdev/firebase/server';

/**
 * Initialize Firebase Admin based on environment
 * Uses provider which handles both Firebase Functions and Vercel
 */
export async function initializeFirebaseAdmin() {
  return await getFirebaseAdminApp();
}
