// packages/functions/src/supabase/auth/getCustomClaims.ts

/**
 * @fileoverview Get Custom Claims Supabase Edge Function
 * @description Returns the authenticated user's app_metadata (custom claims).
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

const getCustomClaimsSchema = v.object({});

// =============================================================================
// Handler
// =============================================================================

/**
 * Create a Supabase Edge Function handler for retrieving custom claims (app_metadata).
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/get-custom-claims/index.ts
 * import { createGetCustomClaims } from '@donotdev/functions/supabase';
 * Deno.serve(createGetCustomClaims());
 * ```
 *
 * @version 0.1.0
 * @since 0.6.0
 */
export function createGetCustomClaims() {
  return createSupabaseHandler(
    'get-custom-claims',
    getCustomClaimsSchema,
    async (_data, ctx) => {
      const {
        data: { user },
        error,
      } = await ctx.supabaseAdmin.auth.admin.getUserById(ctx.uid);
      if (error || !user) {
        throw new Error('User not found');
      }

      return { customClaims: user.app_metadata ?? {} };
    },
    'user'
  );
}
