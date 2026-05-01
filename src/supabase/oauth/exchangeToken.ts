// packages/functions/src/supabase/oauth/exchangeToken.ts

/**
 * @fileoverview OAuth token exchange Supabase Edge Function
 * @description Supabase Edge Function for exchanging OAuth codes for tokens
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  OAUTH_PARTNERS,
  exchangeTokenSchema,
  sanitizeHref,
  type ExchangeTokenRequest,
  type OAuthPartnerId,
} from '@donotdev/core/server';

import { createSupabaseHandler } from '../baseFunction.js';
import type { SupabaseHandlerContext } from '../baseFunction.js';

/**
 * Sanitize profile data from external OAuth providers.
 * Strips HTML tags and limits string length to prevent stored XSS.
 */
function sanitizeProfileData(
  data: Record<string, unknown>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string') {
      result[key] = value.replace(/<[^>]*>/g, '').slice(0, 1000);
    } else if (
      typeof value === 'object' &&
      value !== null &&
      !Array.isArray(value)
    ) {
      result[key] = sanitizeProfileData(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/** Cross-runtime env var access (Deno Edge Functions + Node tests) */
function getEnv(key: string): string | undefined {
  return typeof Deno !== 'undefined' ? Deno.env.get(key) : process.env[key];
}

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;

/**
 * Create an OAuth token exchange Edge Function handler
 *
 * @example
 * ```typescript
 * import { createExchangeToken } from '@donotdev/functions/supabase';
 * Deno.serve(createExchangeToken());
 * ```
 *
 * @version 0.1.0
 * @since 0.1.0
 */
export function createExchangeToken() {
  return createSupabaseHandler(
    'exchange-token',
    exchangeTokenSchema,
    async (data: ExchangeTokenRequest, ctx: SupabaseHandlerContext) => {
      const { provider, purpose, code, redirectUri, codeVerifier } = data;

      // Validate redirectUri scheme (defense-in-depth over Valibot v.url())
      if (!sanitizeHref(redirectUri)) {
        throw new Error('Invalid redirect URI scheme');
      }

      // Get provider endpoints
      const endpoints = OAUTH_PARTNERS[provider];
      if (!endpoints?.endpoints?.tokenUrl) {
        throw new Error(`Provider ${provider} is not supported`);
      }

      // Get client credentials from env: {PROVIDER}_CLIENT_ID, {PROVIDER}_CLIENT_SECRET
      const upper = provider.toUpperCase();
      const clientId = getEnv(`${upper}_CLIENT_ID`);
      const clientSecret = getEnv(`${upper}_CLIENT_SECRET`);

      if (!clientId || !clientSecret) {
        throw new Error(`Provider ${provider} is not configured`);
      }

      // Exchange code for token
      const tokenResponse = await fetch(endpoints.endpoints.tokenUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Accept: 'application/json',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri,
          ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
        }).toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        console.error(
          `Token exchange error for ${provider}: ${tokenResponse.status}`,
          errorText
        );
        throw new Error(
          `Failed to exchange code for token: ${tokenResponse.status}`
        );
      }

      const tokenData = (await tokenResponse.json()) as any;

      // Format credentials
      const credentials = {
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token || null,
        expiresAt: tokenData.expires_in
          ? Math.floor(Date.now() / 1000) + tokenData.expires_in
          : null,
        idToken: tokenData.id_token || null,
        scope: tokenData.scope ? tokenData.scope.split(' ') : [],
      };

      // Get user profile
      let profile: Record<string, unknown> | null = null;
      if (credentials.accessToken && endpoints.endpoints.profileUrl) {
        try {
          const profileResponse = await fetch(endpoints.endpoints.profileUrl, {
            headers: {
              Authorization: `Bearer ${credentials.accessToken}`,
              Accept: 'application/json',
            },
          });
          if (profileResponse.ok) {
            const rawProfile = await profileResponse.json();
            // Sanitize profile data from external provider (prevent stored XSS)
            profile = sanitizeProfileData(rawProfile);
          }
        } catch (e) {
          console.warn(`Failed to fetch profile for ${provider}:`, e);
        }
      }

      // Save connection to Supabase
      const { error: upsertError } = await ctx.supabaseAdmin
        .from('oauth_connections')
        .upsert(
          {
            user_id: ctx.uid,
            provider,
            purpose,
            credentials,
            profile,
            connected: true,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'user_id,provider,purpose' }
        );

      if (upsertError) {
        console.error('Error saving OAuth connection:', upsertError);
      }

      return { success: true, credentials, profile };
    }
  );
}
