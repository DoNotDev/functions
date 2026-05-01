// packages/functions/src/shared/utils.ts

/**
 * @fileoverview Shared utilities for Firebase and Vercel functions
 * @description Common utilities that can be used by both Firebase and Vercel function implementations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import Stripe from 'stripe';
import * as v from 'valibot';

import { DoNotDevError } from '@donotdev/core/server';
import type { OAuthPartnerId, UserRole } from '@donotdev/core/server';
import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
  initFirebaseAdmin,
} from '@donotdev/firebase/server';

import {
  assertAuthenticated as internalAssertAuthenticated,
  assertAdmin as internalAssertAdmin,
} from './utils/internal/auth.js';

// Re-export DoNotDevError for external use
export { DoNotDevError };

/**
 * Get Firestore instance using @donotdev/firebase/server
 * Provider handles initialization and caching
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getFirestore() {
  return getFirebaseAdminFirestore();
}

/**
 * Get Auth instance using @donotdev/firebase/server
 * Provider handles initialization and caching
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getAuth() {
  return getFirebaseAdminAuth();
}

// Lazy initialization of Stripe
let _stripe: Stripe | null = null;

/**
 * Initialize Stripe explicitly (e.g. with a secret from defineSecret)
 * @param apiKey - Stripe secret key
 */
export function initStripe(apiKey: string) {
  if (!apiKey) throw new Error('Stripe API key is required');

  const apiVersion = process.env.STRIPE_API_VERSION || '2024-12-18.acacia'; // Fallback or strict latest

  _stripe = new Stripe(apiKey, {
    apiVersion: apiVersion as any,
  });
  return _stripe;
}

/**
 * Get Stripe instance with lazy initialization
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getStripe(): Stripe {
  if (!_stripe) {
    // Legacy/Vercel fallback: Try process.env
    const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
    if (STRIPE_SECRET_KEY) {
      initStripe(STRIPE_SECRET_KEY);
    } else {
      throw new Error(
        'Stripe not initialized. Call initStripe() or set STRIPE_SECRET_KEY env var.'
      );
    }
  }
  // We know _stripe is set here or we threw
  return _stripe!;
}

/**
 * Lazy-initialized Stripe instance proxy
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const stripe = new Proxy({} as Stripe, {
  get(target, prop) {
    return getStripe()[prop as keyof Stripe];
  },
});

/**
 * Assert that a user is authenticated from a Firebase callable auth context.
 *
 * @deprecated Import `assertAuthenticated` from `@donotdev/functions/shared/utils/internal/auth` instead.
 * This wrapper extracts uid from a Firebase callable auth context and delegates
 * to the canonical version.
 *
 * @param auth - Firebase callable request auth context (object with `.uid`)
 * @returns The authenticated user's uid
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function assertAuthenticated(auth: any): string {
  const uid = auth?.uid;
  if (!uid) {
    throw new Error('User must be authenticated');
  }
  return internalAssertAuthenticated(uid);
}

/**
 * Get user role from Firebase auth context
 *
 * Determines the user's role for visibility filtering based on:
 * - auth.uid: If missing → 'guest'
 * - auth.token.isSuper: If true → 'super'
 * - auth.token.isAdmin: If true → 'admin'
 * - Otherwise → 'user' (authenticated)
 *
 * @param auth - Firebase auth context from callable function
 * @returns UserRole for visibility filtering
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function getUserRole(auth: any): UserRole {
  if (!auth?.uid) return 'guest';

  // Check role claim (standard pattern: auth.token.role = 'admin' | 'super' | etc.)
  const role = auth.token?.role;
  if (role === 'super') return 'super';
  if (role === 'admin') return 'admin';

  // Fallback: check legacy boolean flags for backward compatibility
  if (auth.token?.isSuper) return 'super';
  if (auth.token?.isAdmin) return 'admin';

  return 'user';
}

/**
 * Validates that required Stripe environment variables are set
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateStripeEnvironment(): void {
  // Functions v2 automatically injects secrets as process.env when declared in config
  const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
  if (!STRIPE_SECRET_KEY) {
    throw new Error('Missing STRIPE_SECRET_KEY environment variable');
  }
}

/**
 * Creates a standardized success response
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createSuccessResponse<T>(data: T): { success: true; data: T } {
  return {
    success: true,
    data,
  };
}

/**
 * Creates a standardized error response
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createErrorResponse(error: unknown): {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
} {
  if (error instanceof DoNotDevError) {
    return {
      success: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  if (error instanceof Error) {
    return {
      success: false,
      error: {
        code: 'internal',
        message: error.message,
      },
    };
  }

  return {
    success: false,
    error: {
      code: 'internal',
      message: 'An unexpected error occurred',
    },
  };
}

/**
 * Updates user subscription in Firebase.
 *
 * **Architecture decision — throwing stubs for billing functions:**
 * These subscription functions (`updateUserSubscription`, `getUserSubscription`,
 * `cancelUserSubscription`, `handleSubscriptionCancellation`) are intentional
 * placeholder implementations. They exist so the framework compiles and
 * type-checks out of the box, but throw at runtime to surface missing
 * integration early. Consumer apps replace them with their billing provider
 * integration (Stripe, Paddle, LemonSqueezy, etc.) via the documented
 * `shared/billing/helpers/` modules.
 *
 * C10: This was a silent no-op stub. It now throws to surface the missing
 * implementation at startup rather than silently dropping webhook events.
 * Use `updateUserSubscription` from `shared/billing/helpers/updateUserSubscription.ts`
 * (which requires an authProvider) instead.
 *
 * @deprecated Import `updateUserSubscription` from `@donotdev/functions/shared/billing/helpers/updateUserSubscription`.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function updateUserSubscription(
  _firebaseUid: string,
  _subscription: any
): Promise<void> {
  throw new DoNotDevError(
    'updateUserSubscription stub called — import from shared/billing/helpers/updateUserSubscription.ts and supply an authProvider',
    'unimplemented'
  );
}

/**
 * Gets user subscription from Firebase.
 *
 * C10: This was a silent no-op stub. Now throws to surface the missing implementation.
 *
 * @deprecated Import from `@donotdev/functions/shared/billing/helpers` or implement directly using Firebase Admin SDK / Stripe API.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getUserSubscription(_firebaseUid: string): Promise<any> {
  throw new DoNotDevError(
    'getUserSubscription stub called — implement using Firebase Admin SDK or Stripe API',
    'unimplemented'
  );
}

/**
 * Cancels user subscription.
 *
 * C10: This was a silent no-op stub. Now throws to surface the missing implementation.
 *
 * @deprecated Import `cancelUserSubscription` from `@donotdev/functions/shared/billing/helpers/subscriptionManagement`.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function cancelUserSubscription(
  _firebaseUid: string,
  _subscription: any
): Promise<void> {
  throw new DoNotDevError(
    'cancelUserSubscription stub called — import from shared/billing/helpers/subscriptionManagement.ts',
    'unimplemented'
  );
}

/**
 * Handles subscription cancellation.
 *
 * C10: This was a silent no-op stub. Now throws to surface the missing implementation.
 *
 * @deprecated Handle via Stripe webhook events. Use `processWebhook` from `@donotdev/functions/shared/billing/webhookHandler`.
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function handleSubscriptionCancellation(
  _firebaseUid: string,
  _subscription: any
): Promise<void> {
  throw new DoNotDevError(
    'handleSubscriptionCancellation stub called — handle via Stripe webhook events',
    'unimplemented'
  );
}

/**
 * Asserts that a user has admin privileges
 * Uses role hierarchy: super > admin > user > guest
 *
 * @deprecated Import `assertAdmin` from `@donotdev/functions/shared/utils/internal/auth` instead.
 * This is a thin wrapper that delegates to the canonical provider-agnostic version.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function assertAdmin(uid: string): Promise<string> {
  return internalAssertAdmin(uid);
}

/**
 * Validates document data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateDocument(data: any, schema?: any): void {
  if (!data || typeof data !== 'object') {
    throw new Error('Invalid document data');
  }

  if (Array.isArray(data)) {
    throw new Error('Document data cannot be an array');
  }

  // Run Valibot schema validation when a schema is provided
  if (schema) {
    try {
      v.parse(schema, data);
    } catch (error: any) {
      if (error?.issues) {
        const messages = error.issues
          .map(
            (issue: v.BaseIssue<unknown>) =>
              `${issue.path?.map((p: any) => p.key).join('.') || 'root'}: ${issue.message}`
          )
          .join('; ');
        throw new DoNotDevError(
          `Validation failed: ${messages}`,
          'invalid-argument',
          { details: { validationErrors: error.issues } }
        );
      }
      throw error;
    }
  }
}

/**
 * Validates a Firestore collection name from client-supplied schema.
 *
 * W22: Vercel CRUD handlers accept `schema` (including collection name) from
 * the client. This is a known design limitation. As a defense-in-depth measure,
 * reject collection names that could be used for path traversal or access to
 * internal collections.
 *
 * @param name - Collection name to validate
 * @throws Error if the name is unsafe
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateCollectionName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Collection name is required');
  }
  if (name.includes('/') || name.includes('..') || name.startsWith('_')) {
    throw new Error(
      'Invalid collection name: must not contain "/", "..", or start with "_"'
    );
  }
}

/**
 * Verifies Firebase auth token
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function verifyFirebaseAuthToken(token: string): Promise<string> {
  if (!token) {
    throw new DoNotDevError('Missing authentication token', 'unauthenticated');
  }

  try {
    const decodedToken = await getFirebaseAdminAuth().verifyIdToken(token);
    return decodedToken.uid;
  } catch (error) {
    throw new DoNotDevError('Invalid or expired token', 'unauthenticated');
  }
}

/**
 * Finds references to a document
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function findReferences(
  collection: string,
  docId: string,
  referenceMetadata?: {
    incoming?: Array<{
      sourceCollection: string;
      sourceField: string;
    }>;
  }
): Promise<Array<{ collection: string; field: string; count: number }>> {
  const references: Array<{
    collection: string;
    field: string;
    count: number;
  }> = [];

  if (!referenceMetadata?.incoming?.length) {
    return references;
  }

  const db = getFirebaseAdminFirestore();

  for (const ref of referenceMetadata.incoming) {
    const snapshot = await db
      .collection(ref.sourceCollection)
      .where(ref.sourceField, '==', docId)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      references.push({
        collection: ref.sourceCollection,
        field: ref.sourceField,
        count: snapshot.size,
      });
    }
  }

  return references;
}
