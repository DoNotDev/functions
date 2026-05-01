// packages/functions/src/supabase/oauth/disconnect.ts

/**
 * @fileoverview OAuth disconnect Supabase Edge Function
 * @description Supabase Edge Function for disconnecting OAuth providers
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  OAUTH_PARTNERS,
  type OAuthPartnerId,
  type OAuthPurpose,
} from '@donotdev/core/server';

import { createSupabaseHandler } from '../baseFunction.js';
import type { SupabaseHandlerContext } from '../baseFunction.js';

const disconnectSchema = v.object({
  provider: v.string() as v.BaseSchema<
    unknown,
    OAuthPartnerId,
    v.BaseIssue<unknown>
  >,
  purpose: v.picklist(['authentication', 'api-access']) as v.BaseSchema<
    unknown,
    OAuthPurpose,
    v.BaseIssue<unknown>
  >,
});

/**
 * Create an OAuth disconnect Edge Function handler
 *
 * @example
 * ```typescript
 * import { createDisconnect } from '@donotdev/functions/supabase';
 * Deno.serve(createDisconnect());
 * ```
 *
 * @version 0.1.0
 * @since 0.1.0
 */
export function createDisconnect() {
  return createSupabaseHandler(
    'disconnect',
    disconnectSchema,
    async (
      data: { provider: OAuthPartnerId; purpose: OAuthPurpose },
      ctx: SupabaseHandlerContext
    ) => {
      const { provider, purpose } = data;

      // Get existing connection to revoke token
      const { data: connection } = await ctx.supabaseAdmin
        .from('oauth_connections')
        .select('credentials')
        .eq('user_id', ctx.uid)
        .eq('provider', provider)
        .eq('purpose', purpose)
        .single();

      // Revoke token if possible
      if (connection?.credentials?.accessToken) {
        const endpoints = OAUTH_PARTNERS[provider];
        const revokeUrl = 'revokeUrl' in endpoints ? endpoints.revokeUrl : null;
        if (revokeUrl) {
          try {
            await fetch(revokeUrl.toString(), {
              method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
              },
              body: new URLSearchParams({
                token: connection.credentials.accessToken,
              }).toString(),
            });
          } catch (e) {
            console.warn(`Failed to revoke token for ${provider}:`, e);
          }
        }
      }

      // Delete connection
      const { error } = await ctx.supabaseAdmin
        .from('oauth_connections')
        .delete()
        .eq('user_id', ctx.uid)
        .eq('provider', provider)
        .eq('purpose', purpose);

      if (error) {
        throw new Error(`Failed to disconnect: ${error.message}`);
      }

      return { success: true };
    }
  );
}
