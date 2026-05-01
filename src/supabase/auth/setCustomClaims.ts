// packages/functions/src/supabase/auth/setCustomClaims.ts

/**
 * @fileoverview Set Custom Claims Supabase Edge Function
 * @description Merges custom claims into the user's app_metadata.
 * Mirrors the Firebase pattern: consumer provides an explicit allowlist,
 * framework enforces a blocklist as safety net.
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

const setCustomClaimsSchema = v.object({
  customClaims: v.record(v.string(), v.unknown()),
  idempotencyKey: v.optional(v.string()),
});

/**
 * Claim keys that must NEVER be self-assignable - privilege escalation vectors.
 * Matches Firebase `BLOCKED_CLAIM_KEYS`.
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
// Types
// =============================================================================

/** Options for the set-custom-claims edge function factory. */
export interface SetCustomClaimsOptions {
  /** Explicit allowlist of claim keys users may set on themselves. Required. */
  allowedClaimKeys: string[];
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Create a Supabase Edge Function handler for setting custom claims (app_metadata).
 *
 * Consumers MUST specify which claim keys are self-assignable.
 * The framework enforces a blocklist as a safety net even if the consumer
 * accidentally includes a privilege key.
 *
 * @param options - Configuration with allowedClaimKeys
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/set-custom-claims/index.ts
 * import { createSetCustomClaims } from '@donotdev/functions/supabase';
 * Deno.serve(createSetCustomClaims({ allowedClaimKeys: ['theme', 'locale'] }));
 * ```
 *
 * @version 0.2.0
 * @since 0.6.0
 */
export function createSetCustomClaims(options: SetCustomClaimsOptions) {
  const allowedKeys = new Set(options.allowedClaimKeys);

  // Fail fast if consumer accidentally allows a privilege key
  for (const key of allowedKeys) {
    if (BLOCKED_CLAIM_KEYS.has(key)) {
      throw new Error(
        `Claim key "${key}" is blocked - it is a privilege-escalation vector and cannot be self-assigned.`
      );
    }
  }

  return createSupabaseHandler(
    'set-custom-claims',
    setCustomClaimsSchema,
    async (data, ctx) => {
      // Only allow keys from the consumer-provided allowlist
      const disallowedKeys = Object.keys(data.customClaims).filter(
        (k) => !allowedKeys.has(k)
      );
      if (disallowedKeys.length > 0) {
        throw new Error(`Claim keys not allowed: ${disallowedKeys.join(', ')}`);
      }

      // Get current app_metadata
      const {
        data: { user },
        error: getUserError,
      } = await ctx.supabaseAdmin.auth.admin.getUserById(ctx.uid);
      if (getUserError || !user) {
        throw new Error('User not found');
      }

      // Merge new claims with existing app_metadata
      const existingClaims = (user.app_metadata ?? {}) as Record<
        string,
        unknown
      >;
      const updatedClaims = { ...existingClaims, ...data.customClaims };

      // Update app_metadata
      const { error: updateError } =
        await ctx.supabaseAdmin.auth.admin.updateUserById(ctx.uid, {
          app_metadata: updatedClaims,
        });
      if (updateError) throw updateError;

      return { success: true, customClaims: updatedClaims };
    },
    'user'
  );
}
