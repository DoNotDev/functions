// packages/functions/src/supabase/auth/deleteAccount.ts

/**
 * @fileoverview Delete Account Supabase Edge Function
 * @description Deletes the authenticated user's account via Supabase Admin, after an
 * optional consumer `beforeDelete` step that can refuse the deletion.
 *
 * @version 0.2.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { createSupabaseHandler } from '../baseFunction.js';
import type { SupabaseHandlerContext } from '../baseFunction.js';

// =============================================================================
// Schema
// =============================================================================

const deleteAccountSchema = v.object({});

// =============================================================================
// Types
// =============================================================================

/**
 * Options for {@link createDeleteAccount}.
 *
 * @version 0.2.0
 * @since 0.2.3
 */
export interface DeleteAccountOptions {
  /**
   * Runs before the auth user is deleted (close the account, anonymize data, cancel
   * subscriptions...). Throwing refuses the deletion: the user is NOT deleted and the
   * client receives HTTP 409 `{ error: message, code }` (`code` when the thrown error
   * carries a string `code`). The message and code reach the browser unmasked, so
   * throw client-safe values only — a refusal code such as `open_orders` that the
   * client translates under `auth:deleteAccount.errors.<code>` (see `useDeleteAccount`).
   */
  beforeDelete?: (ctx: SupabaseHandlerContext) => Promise<void>;
}

/** HTTP status of a refusal raised by `beforeDelete`. */
const REFUSAL_STATUS = 409;

// =============================================================================
// Handler
// =============================================================================

/** The 409 response carrying a `beforeDelete` refusal to the client. */
function refusalResponse(error: unknown): Response {
  // why: PostgREST/Supabase errors may arrive as plain { message, code } objects
  const record =
    typeof error === 'object' && error !== null
      ? (error as { message?: unknown; code?: unknown })
      : {};
  const message =
    typeof record.message === 'string' ? record.message : String(error);
  const code = typeof record.code === 'string' ? record.code : undefined;
  return new Response(JSON.stringify({ error: message, code }), {
    status: REFUSAL_STATUS,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Create a Supabase Edge Function handler for account deletion.
 *
 * @param options - Optional `beforeDelete` step; without it, deletes the user directly
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/delete-account/index.ts
 * import { createDeleteAccount } from '@donotdev/functions/supabase';
 * Deno.serve(createDeleteAccount());
 * ```
 *
 * @example
 * ```typescript
 * // Refuse while the account still has open orders (the SQL function raises 'open_orders')
 * Deno.serve(
 *   createDeleteAccount({
 *     beforeDelete: async ({ supabaseAdmin, uid }) => {
 *       const { error } = await supabaseAdmin.rpc('close_my_account', { p_uid: uid });
 *       if (error) throw error; // → 409 { error: 'open_orders', code: 'P0001' }
 *     },
 *   })
 * );
 * ```
 *
 * @version 0.2.0
 * @since 0.5.0
 */
export function createDeleteAccount(options: DeleteAccountOptions = {}) {
  const { beforeDelete } = options;
  return createSupabaseHandler(
    'delete-account',
    deleteAccountSchema,
    async (_data, ctx): Promise<{ success: true } | Response> => {
      if (beforeDelete) {
        try {
          await beforeDelete(ctx);
        } catch (error) {
          console.error('[delete-account] beforeDelete refused:', error);
          return refusalResponse(error);
        }
      }

      const { error } = await ctx.supabaseAdmin.auth.admin.deleteUser(ctx.uid);
      if (error) throw error;

      return { success: true };
    }
  );
}
