// packages/functions/src/shared/utils.ts

/**
 * @fileoverview Shared utilities for Firebase and Vercel functions
 * @description Common utilities that can be used by both Firebase and Vercel function implementations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { DoNotDevError } from '@donotdev/core/server';
import type { OAuthPartnerId, UserRole } from '@donotdev/core/server';

// Re-export DoNotDevError for external use
export { DoNotDevError };

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

  // Lazy: the Vercel/Supabase entries must load without firebase-admin
  const { getFirebaseAdminAuth } = await import('@donotdev/firebase/server');
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

  // Lazy: the Vercel/Supabase entries must load without firebase-admin
  const { getFirebaseAdminFirestore } =
    await import('@donotdev/firebase/server');
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
