// packages/functions/src/supabase/oauth/refreshToken.ts

/**
 * @fileoverview OAuth token refresh Supabase Edge Function
 * @description Supabase Edge Function for refreshing OAuth tokens
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  OAUTH_PARTNERS,
  type OAuthRefreshRequest,
} from '@donotdev/core/server';

import { createSupabaseHandler } from '../baseFunction.js';
import type { SupabaseHandlerContext } from '../baseFunction.js';

/** Cross-runtime env var access (Deno Edge Functions + Node tests) */
function getEnv(key: string): string | undefined {
  return typeof Deno !== 'undefined' ? Deno.env.get(key) : process.env[key];
}

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;

const refreshTokenSchema = v.object({
  provider: v.string() as v.BaseSchema<
    unknown,
    OAuthRefreshRequest['provider'],
    v.BaseIssue<unknown>
  >,
  refreshToken: v.pipe(v.string(), v.minLength(1, 'Refresh token is required')),
  redirectUri: v.pipe(v.string(), v.url('Valid redirect URI is required')),
});

/**
 * Create an OAuth token refresh Edge Function handler
 *
 * @example
 * ```typescript
 * import { createRefreshToken } from '@donotdev/functions/supabase';
 * Deno.serve(createRefreshToken());
 * ```
 *
 * @version 0.1.0
 * @since 0.1.0
 */
export function createRefreshToken() {
  return createSupabaseHandler(
    'refresh-token',
    refreshTokenSchema,
    async (data: OAuthRefreshRequest, ctx: SupabaseHandlerContext) => {
      const { provider, refreshToken: refreshTokenValue, redirectUri } = data;

      // Get provider endpoints
      const endpoints = OAUTH_PARTNERS[provider];
      if (!endpoints?.endpoints?.tokenUrl) {
        throw new Error(`Provider ${provider} does not support token refresh`);
      }

      // Get client credentials: {PROVIDER}_CLIENT_ID, {PROVIDER}_CLIENT_SECRET
      const upper = provider.toUpperCase();
      const clientId = getEnv(`${upper}_CLIENT_ID`);
      const clientSecret = getEnv(`${upper}_CLIENT_SECRET`);

      if (!clientId || !clientSecret) {
        throw new Error(`Provider ${provider} is not configured`);
      }

      // Refresh the token
      const response = await fetch(endpoints.endpoints.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshTokenValue,
          redirect_uri: redirectUri,
        }).toString(),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`Token refresh error for ${provider}:`, errorText);
        throw new Error(`Failed to refresh token: ${response.status}`);
      }

      const tokenData = (await response.json()) as any;

      const credentials = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || refreshTokenValue,
        expiresAt: tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : null,
        scope: tokenData.scope ? tokenData.scope.split(' ') : [],
      };

      // Update connection in Supabase
      const { error: updateError } = await ctx.supabaseAdmin
        .from('oauth_connections')
        .update({
          credentials,
          updated_at: new Date().toISOString(),
        })
        .eq('user_id', ctx.uid)
        .eq('provider', provider);

      if (updateError) {
        console.error('Error updating OAuth connection:', updateError);
      }

      return { success: true, credentials };
    }
  );
}
