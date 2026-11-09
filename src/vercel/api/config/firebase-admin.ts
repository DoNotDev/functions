// packages/functions/src/vercel/api/config/firebase-admin.ts

/**
 * @fileoverview Firebase Admin SDK initialization for Vercel functions
 * @description Re-exports provider functions for Vercel-specific access
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { App } from 'firebase-admin/app';

/**
 * Initialize Firebase Admin SDK for Vercel environment
 * Uses provider which handles service account credentials from environment variables
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function initializeFirebaseAdmin(): Promise<App> {
  const { getFirebaseAdminApp } = await import('@donotdev/firebase/server');
  return await getFirebaseAdminApp();
}

/**
 * Get the initialized Firebase Admin app
 * Initializes if not already done
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getFirebaseAdmin(): Promise<App> {
  const { getFirebaseAdminApp } = await import('@donotdev/firebase/server');
  return await getFirebaseAdminApp();
}
