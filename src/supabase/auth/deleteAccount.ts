// packages/functions/src/supabase/auth/deleteAccount.ts

/**
 * @fileoverview Delete Account Supabase Edge Function
 * @description Deletes the authenticated user's account via Supabase Admin.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { createSupabaseHandler } from '../baseFunction.js';

// =============================================================================
// Schema
// =============================================================================

const deleteAccountSchema = v.object({});

// =============================================================================
// Handler
// =============================================================================

/**
 * Create a Supabase Edge Function handler for account deletion.
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/delete-account/index.ts
 * import { createDeleteAccount } from '@donotdev/functions/supabase';
 * Deno.serve(createDeleteAccount());
 * ```
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createDeleteAccount() {
  return createSupabaseHandler(
    'delete-account',
    deleteAccountSchema,
    async (_data, ctx) => {
      const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(ctx.uid);
      if (error) throw error;

      return { success: true };
    }
  );
}
