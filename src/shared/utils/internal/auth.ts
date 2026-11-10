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

import type { NextApiRequest } from 'next';
import * as v from 'valibot';

import { DoNotDevError, hasProvider, getProvider } from '@donotdev/core/server';

/**
 * Auth backends a server function can be explicitly configured with.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const AuthBackendSchema = v.picklist(['firebase', 'supabase']);

/** Auth provider type for explicit configuration */
export type AuthProvider = v.InferOutput<typeof AuthBackendSchema>;

/**
 * Validate an auth backend at runtime. Values typed as `AuthProvider` can
 * still arrive as arbitrary strings from JS or env-driven config, and an
 * unknown value must never silently run as Firebase.
 *
 * @param backend - Value to validate
 * @returns The validated backend
 * @throws DoNotDevError (`invalid-argument`) naming the allowed values
 *
 * @example
 * ```typescript
 * const backend = parseAuthBackend(process.env.AUTH_BACKEND); // 'firebase' | 'supabase'
 * ```
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function parseAuthBackend(backend: unknown): AuthProvider {
  const result = v.safeParse(AuthBackendSchema, backend);
  if (!result.success) {
    const allowed = AuthBackendSchema.options.map((o) => `'${o}'`).join(', ');
    throw new DoNotDevError(
      `Invalid backend ${JSON.stringify(backend)}: expected one of ${allowed}`,
      'invalid-argument'
    );
  }
  return result.output;
}

// IMPORTANT: Don't call getAuth() at module load - breaks Firebase deployment

/**
 * Firebase Admin Auth, loaded on first use. `firebase-admin` is an optional
 * peer: Supabase deployments never load it.
 */
async function getFirebaseAuth() {
  const { getFirebaseAdminAuth } = await import('@donotdev/firebase/server');
  return getFirebaseAdminAuth();
}

/**
 * Validates that user is authenticated
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function assertAuthenticated(uid: string | undefined): string {
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
      const user = await (await getFirebaseAuth()).getUser(uid);
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
      const decodedToken = await (await getFirebaseAuth()).verifyIdToken(token);
      return { uid: decodedToken.uid };
    }

    // Auto-detect: provider registry first, then Firebase fallback
    if (hasProvider('serverAuth')) {
      const verified = await getProvider('serverAuth').verifyToken(token);
      return { uid: verified.uid };
    }

    // Legacy Firebase path
    const decodedToken = await (await getFirebaseAuth()).verifyIdToken(token);
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
