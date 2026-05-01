// packages/functions/src/supabase/auth/getUserAuthStatus.ts

/**
 * @fileoverview Get User Auth Status Supabase Edge Function
 * @description Returns the authenticated user's profile and custom claims.
 *
 * @version 0.1.0
 * @since 0.6.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { createSupabaseHandler } from '../baseFunction.js';

// =============================================================================
// Schema
// =============================================================================

const getUserAuthStatusSchema = v.object({});

// =============================================================================
// Handler
// =============================================================================

/**
 * Create a Supabase Edge Function handler for retrieving user auth status.
 *
 * Returns uid, email, verification status, custom claims, and ban status.
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/get-user-auth-status/index.ts
 * import { createGetUserAuthStatus } from '@donotdev/functions/supabase';
 * Deno.serve(createGetUserAuthStatus());
 * ```
 *
 * @version 0.1.0
 * @since 0.6.0
 */
export function createGetUserAuthStatus() {
  return createSupabaseHandler(
    'get-user-auth-status',
    getUserAuthStatusSchema,
    async (_data, ctx) => {
      const {
        data: { user },
        error,
      } = await ctx.supabaseAdmin.auth.admin.getUserById(ctx.uid);
      if (error || !user) {
        throw new Error('User not found');
      }

      return {
        uid: user.id,
        email: user.email,
        emailVerified: user.email_confirmed_at != null,
        customClaims: user.app_metadata ?? {},
        disabled: user.banned_until != null,
      };
    },
    'user'
  );
}
