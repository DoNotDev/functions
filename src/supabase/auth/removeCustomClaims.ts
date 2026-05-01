// packages/functions/src/supabase/auth/removeCustomClaims.ts

/**
 * @fileoverview Remove Custom Claims Supabase Edge Function
 * @description Removes specific keys from the user's app_metadata.
 * Blocklist prevents removal of security-critical claims.
 *
 * @version 0.2.0
 * @since 0.6.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { createSupabaseHandler } from '../baseFunction.js';

// =============================================================================
// Schema
// =============================================================================

const removeCustomClaimsSchema = v.object({
  claimsToRemove: v.pipe(
    v.array(v.string()),
    v.minLength(1, 'At least one claim key is required')
  ),
});

/**
 * Claim keys that must NEVER be removed by users - privilege/integrity vectors.
 * Matches BLOCKED_CLAIM_KEYS in setCustomClaims.ts.
 */
const BLOCKED_CLAIM_KEYS = new Set([
  'admin',
  'isAdmin',
  'isSuper',
  'isSuperAdmin',
  'role',
  'roles',
  'permissions',
  'superuser',
  'moderator',
  'staff',
  'elevated',
  'plan',
  'tier',
  'provider',
  'providers',
  'sub',
  'iss',
  'aud',
]);

// =============================================================================
// Handler
// =============================================================================

/**
 * Create a Supabase Edge Function handler for removing custom claims from app_metadata.
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/remove-custom-claims/index.ts
 * import { createRemoveCustomClaims } from '@donotdev/functions/supabase';
 * Deno.serve(createRemoveCustomClaims());
 * ```
 *
 * @version 0.2.0
 * @since 0.6.0
 */
export function createRemoveCustomClaims() {
  return createSupabaseHandler(
    'remove-custom-claims',
    removeCustomClaimsSchema,
    async (data, ctx) => {
      // Block removal of security-critical claims
      const blocked = data.claimsToRemove.filter((k) =>
        BLOCKED_CLAIM_KEYS.has(k)
      );
      if (blocked.length > 0) {
        throw new Error(
          `Protected claims cannot be removed: ${blocked.join(', ')}`
        );
      }

      // Get current app_metadata
      const {
        data: { user },
        error: getUserError,
      } = await ctx.supabaseAdmin.auth.admin.getUserById(ctx.uid);
      if (getUserError || !user) {
        throw new Error('User not found');
      }

      // Remove specified keys
      const existingClaims = { ...(user.app_metadata ?? {}) } as Record<
        string,
        unknown
      >;
      for (const key of data.claimsToRemove) {
        delete existingClaims[key];
      }

      // Update app_metadata
      const { error: updateError } =
        await ctx.supabaseAdmin.auth.admin.updateUserById(ctx.uid, {
          app_metadata: existingClaims,
        });
      if (updateError) throw updateError;

      return { success: true, customClaims: existingClaims };
    },
    'user'
  );
}
