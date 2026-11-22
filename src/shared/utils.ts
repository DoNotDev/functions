// packages/functions/src/shared/utils.ts

/**
 * @fileoverview Shared utilities for Firebase, Vercel and Supabase functions
 * @description Common utilities for every function implementation. Provider-neutral:
 * Supabase Edge Functions import this module, and the edge bundler resolves every
 * import in it (even a lazy `import()` that is never called). Firebase-only code
 * lives under `firebase/`.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */


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
export function getUserRole(
  auth: { uid?: string; token?: Record<string, unknown> } | null | undefined
): UserRole {
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
    details?: Record<string, unknown>;
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
