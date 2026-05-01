// packages/functions/src/shared/utils/detectFirestore.ts

/**
 * @fileoverview Firestore Detection Utility
 * @description Detects if Firestore credentials are available
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Check if Firestore is configured in environment
 *
 * Checks for Firebase Admin SDK credentials:
 * - FIREBASE_PROJECT_ID (required)
 * - FIREBASE_CLIENT_EMAIL (service account)
 * - FIREBASE_PRIVATE_KEY (service account)
 *
 * OR checks if running in Firebase Functions environment
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function isFirestoreConfigured(): boolean {
  // Check 1: Running in Firebase Functions (auto-configured)
  if (process.env.FUNCTION_NAME || process.env.FIREBASE_CONFIG) {
    return true;
  }

  // Check 2: Manual Firebase Admin SDK configuration
  const hasProjectId = !!process.env.FIREBASE_PROJECT_ID;
  const hasClientEmail = !!process.env.FIREBASE_CLIENT_EMAIL;
  const hasPrivateKey = !!process.env.FIREBASE_PRIVATE_KEY;

  return hasProjectId && hasClientEmail && hasPrivateKey;
}

/**
 * Check if Firestore is actually available (can connect)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function isFirestoreAvailable(): Promise<boolean> {
  if (!isFirestoreConfigured()) {
    return false;
  }

  try {
    const { getFirebaseAdminFirestore } =
      await import('@donotdev/firebase/server');
    const db = getFirebaseAdminFirestore();

    // Try to access Firestore (lightweight check)
    await db.collection('_health_check').limit(1).get();

    return true;
  } catch (error) {
    console.warn(
      '[Firestore] Not available:',
      error instanceof Error ? error.message : String(error)
    );
    return false;
  }
}
