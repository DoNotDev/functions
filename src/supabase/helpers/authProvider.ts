// packages/functions/src/supabase/helpers/authProvider.ts

/**
 * @fileoverview Supabase Auth Provider for shared billing logic
 * @description Maps Supabase Admin auth to the core `BillingAuthProvider` interface,
 * bridging `app_metadata` ↔ `customClaims`.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import type { BillingAuthProvider } from '@donotdev/core/server';

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a BillingAuthProvider backed by Supabase Admin.
 * `app_metadata` is used as the equivalent of Firebase custom claims.
 *
 * @param supabaseAdmin - Supabase client created with the service role key
 * @returns BillingAuthProvider compatible with shared billing helpers
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createSupabaseAuthProvider(
  supabaseAdmin: SupabaseClient
): BillingAuthProvider {
  return {
    async getUser(userId: string) {
      const { data, error } =
        await supabaseAdmin.auth.admin.getUserById(userId);
      if (error) throw error;
      return { customClaims: data.user?.app_metadata ?? {} };
    },
    async setCustomUserClaims(userId: string, claims: Record<string, unknown>) {
      const { error } = await supabaseAdmin.auth.admin.updateUserById(userId, {
        app_metadata: claims,
      });
      if (error) throw error;
    },
  };
}
