// packages/functions/src/vercel/api/oauth/exchange-token.ts

/**
 * @fileoverview OAuth token exchange API route
 * @description Vercel API route for exchanging OAuth codes for tokens
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import {
  OAUTH_PARTNERS,
  exchangeTokenSchema,
  type ExchangeTokenRequest,
  type TokenResponse,
} from '@donotdev/core/server';

import {
  createSuccessResponse,
  createErrorResponse,
} from '../../../shared/utils.js';
import { createVercelBaseFunction } from '../../baseFunction.js';

import type { NextApiRequest, NextApiResponse } from 'next';
import type * as v from 'valibot';

/** Validate Mastodon instance URL to prevent SSRF */
function validateInstanceUrl(url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:') {
    throw new Error('Instance URL must use HTTPS');
  }
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '::1' ||
    hostname.startsWith('10.') ||
    hostname.startsWith('192.168.') ||
    hostname.startsWith('172.') ||
    hostname === '169.254.169.254' ||
    hostname.endsWith('.internal') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Instance URL must not point to internal addresses');
  }
}

/**
 * Business logic for exchanging OAuth tokens
 * Base function handles: validation, auth, rate limiting, monitoring
 */
async function exchangeTokenLogic(
  req: NextApiRequest,
  res: NextApiResponse,
  data: ExchangeTokenRequest,
  context: { uid: string }
) {
  const { provider, purpose, code, redirectUri, codeVerifier, instance } = data;

  // Get provider endpoints
  let tokenUrl = OAUTH_PARTNERS[provider]?.endpoints?.tokenUrl;

  // Special handling for Mastodon instances
  if (provider === 'mastodon' && instance) {
    validateInstanceUrl(instance);
    tokenUrl = `${instance.replace(/\/$/, '')}/oauth/token` as any;
  }

  if (!tokenUrl) {
    throw new Error(`Provider ${provider} is not supported`);
  }

  // Get environment variables for client credentials
  const clientIdVar = `${provider.toUpperCase()}_CLIENT_ID`;
  const clientSecretVar = `${provider.toUpperCase()}_CLIENT_SECRET`;

  const clientId = process.env[clientIdVar];
  const clientSecret = process.env[clientSecretVar];

  if (!clientId || !clientSecret) {
    throw new Error(`${provider} OAuth is not properly configured`);
  }

  // Prepare token exchange request
  let bodyData: URLSearchParams | string;
  let headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  };

  // Prepare parameters based on provider
  if (provider === 'github') {
    // GitHub prefers JSON
    headers['Content-Type'] = 'application/json';
    headers['User-Agent'] = 'DoNotDev-OAuth-Client';

    const githubBody: Record<string, string> = {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    };

    // Add PKCE code verifier if provided (GitHub supports PKCE)
    if (codeVerifier) {
      githubBody.code_verifier = codeVerifier;
    }

    bodyData = JSON.stringify(githubBody);
  } else {
    // Standard OAuth 2.0 flow
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    // Add PKCE code verifier if provided
    if (codeVerifier) {
      params.append('code_verifier', codeVerifier);
    }

    bodyData = params;
  }

  // Exchange code for token
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: bodyData,
  });

  // Handle HTTP errors
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`Token exchange HTTP error`, {
      provider,
      status: response.status,
      statusText: response.statusText,
      error: errorText,
    });

    throw new Error(
      `Failed to exchange code for token: ${response.status} ${response.statusText}`
    );
  }

  // Parse response
  const tokenData = (await response.json()) as any;

  // Validate required fields
  if (!tokenData.access_token) {
    console.error(`Invalid token response`, {
      provider,
      hasAccessToken: !!tokenData?.access_token,
    });
    throw new Error('Provider returned invalid token format');
  }

  // Return standardized response
  const result: TokenResponse = {
    access_token: tokenData.access_token,
    token_type: tokenData.token_type || 'Bearer',
    expires_in: tokenData.expires_in,
    refresh_token: tokenData.refresh_token,
    scope: tokenData.scope,
    id_token: tokenData.id_token,
    created_at: tokenData.created_at || Math.floor(Date.now() / 1000),
  };

  return res.status(200).json(createSuccessResponse(result));
}

/**
 * Vercel API handler for exchanging OAuth tokens
 * Base function handles all common concerns automatically
 */
const exchangeToken = (
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) => {
  const schema = customSchema || exchangeTokenSchema;
  return createVercelBaseFunction(
    'POST',
    schema,
    'exchange_token',
    exchangeTokenLogic
  );
};

export default exchangeToken;
