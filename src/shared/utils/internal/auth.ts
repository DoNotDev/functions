// packages/functions/src/shared/utils/internal/auth.ts

/**
 * @fileoverview Authentication utility functions
 * @description Provider-agnostic functions for user authentication and authorization.
 * Uses IServerAuthAdapter from provider registry when configured, falls back to Firebase Admin SDK.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { hasProvider, getProvider } from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import type { NextApiRequest } from 'next';

/** Auth provider type for explicit configuration */
export type AuthProvider = 'firebase' | 'supabase';

// IMPORTANT: Don't call getAuth() at module load - breaks Firebase deployment

/**
 * Validates that user is authenticated
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function assertAuthenticated(uid: string): string {
  // G62: Validate uid is a non-empty string — reject non-string values at runtime
  if (!uid || typeof uid !== 'string') {
    throw new Error('Authentication required');
  }
  return uid;
}

/**
 * Validates that user has admin privileges.
 * Uses IServerAuthAdapter when configured, falls back to Firebase Admin SDK.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function assertAdmin(uid: string): Promise<string> {
  assertAuthenticated(uid);

  try {
    let claims: Record<string, unknown> = {};

    if (hasProvider('serverAuth')) {
      const user = await getProvider('serverAuth').getUser(uid);
      claims = (user?.customClaims as Record<string, unknown>) ?? {};
    } else {
      // Legacy Firebase path
      const user = await getFirebaseAdminAuth().getUser(uid);
      claims = user.customClaims ?? {};
    }

    // W8: Unified role-check logic consistent with shared/utils.ts:assertAdmin.
    // Check role string first (standard), then legacy boolean flags.
    const role = claims.role;
    const isAdmin =
      role === 'admin' ||
      role === 'super' ||
      claims.isAdmin === true ||
      claims.isSuper === true;

    if (!isAdmin) {
      throw new Error('Admin privileges required');
    }

    return uid;
  } catch (error) {
    // C4: Re-throw permission-denied as-is so callers can distinguish it from
    // infrastructure failures. Only wrap genuine unexpected errors.
    if (
      error instanceof Error &&
      error.message === 'Admin privileges required'
    ) {
      throw error;
    }
    throw new Error('Failed to verify admin status');
  }
}

/**
 * Extract Bearer token from authorization header.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */
function extractBearerToken(authHeader: string | undefined): string {
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Missing or invalid authorization header');
  }

  const token = authHeader.split('Bearer ')[1];

  if (!token) {
    throw new Error('Missing token in authorization header');
  }

  return token;
}

/**
 * Verify a Bearer token using the specified auth provider.
 * Returns `{ uid: string }` on success, throws on failure.
 *
 * Provider resolution order:
 * 1. Explicit `provider` parameter ('firebase' | 'supabase')
 * 2. Provider registry (IServerAuthAdapter via `hasProvider('serverAuth')`)
 * 3. Firebase Admin SDK fallback
 *
 * @param token - Raw JWT token (without "Bearer " prefix)
 * @param provider - Optional explicit auth provider
 * @returns Object with verified user's uid
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */
export async function verifyToken(
  token: string,
  provider?: AuthProvider
): Promise<{ uid: string }> {
  try {
    // Explicit provider
    if (provider === 'supabase') {
      return await verifySupabaseToken(token);
    }

    if (provider === 'firebase') {
      const decodedToken = await getFirebaseAdminAuth().verifyIdToken(token);
      return { uid: decodedToken.uid };
    }

    // Auto-detect: provider registry first, then Firebase fallback
    if (hasProvider('serverAuth')) {
      const verified = await getProvider('serverAuth').verifyToken(token);
      return { uid: verified.uid };
    }

    // Legacy Firebase path
    const decodedToken = await getFirebaseAdminAuth().verifyIdToken(token);
    return { uid: decodedToken.uid };
  } catch (error) {
    throw new Error('Invalid or expired token');
  }
}

/**
 * Verify a Supabase JWT token using the Supabase admin client.
 * Requires SUPABASE_URL and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) env vars.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */
async function verifySupabaseToken(token: string): Promise<{ uid: string }> {
  // Lazy import to avoid pulling in @supabase/supabase-js when using Firebase
  const { createClient } = await import('@supabase/supabase-js');

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !secretKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY environment variables'
    );
  }

  const supabaseAdmin = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const {
    data: { user },
    error,
  } = await supabaseAdmin.auth.getUser(token);

  if (error || !user) {
    throw new Error('Invalid or expired token');
  }

  return { uid: user.id };
}

/**
 * Verifies auth token from request.
 * Uses IServerAuthAdapter when configured, falls back to Firebase Admin SDK.
 *
 * @param req - Next.js API request
 * @param provider - Optional explicit auth provider ('firebase' | 'supabase')
 * @returns Verified user's uid
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function verifyAuthToken(
  req: NextApiRequest,
  provider?: AuthProvider
): Promise<string> {
  const token = extractBearerToken(req.headers.authorization);
  const { uid } = await verifyToken(token, provider);
  return uid;
}

/**
 * @deprecated Use verifyAuthToken instead. Kept for backwards compatibility.
 */
export const verifyFirebaseAuthToken = verifyAuthToken;
