// packages/functions/src/supabase/oauth/getConnections.ts

/**
 * @fileoverview Get OAuth connections Supabase Edge Function
 * @description Supabase Edge Function for retrieving user OAuth connections
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { OAuthPurpose } from '@donotdev/core/server';

import { createSupabaseHandler } from '../baseFunction.js';
import type { SupabaseHandlerContext } from '../baseFunction.js';

const getConnectionsSchema = v.object({
  purpose: v.optional(
    v.picklist(['authentication', 'api-access']) as v.BaseSchema<
      unknown,
      OAuthPurpose,
      v.BaseIssue<unknown>
    >
  ),
});

/**
 * Create a get OAuth connections Edge Function handler
 *
 * @example
 * ```typescript
 * import { createGetConnections } from '@donotdev/functions/supabase';
 * Deno.serve(createGetConnections());
 * ```
 *
 * @version 0.1.0
 * @since 0.1.0
 */
export function createGetConnections() {
  return createSupabaseHandler(
    'get-connections',
    getConnectionsSchema,
    async (data: { purpose?: OAuthPurpose }, ctx: SupabaseHandlerContext) => {
      let query = ctx.supabaseAdmin
        .from('oauth_connections')
        .select('*')
        .eq('user_id', ctx.uid);

      if (data.purpose) {
        query = query.eq('purpose', data.purpose);
      }

      const { data: rows, error } = await query;

      if (error) {
        throw new Error(`Failed to get connections: ${error.message}`);
      }

      const connections = (rows || []).map((row: any) => {
        const isExpired = row.credentials?.expiresAt
          ? row.credentials.expiresAt < Math.floor(Date.now() / 1000)
          : false;

        return {
          id: row.id,
          userId: row.user_id,
          provider: row.provider,
          purpose: row.purpose,
          connected: !isExpired,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          hasCredentials: !isExpired && !!row.credentials,
          profile: row.profile,
        };
      });

      return { connections };
    }
  );
}
