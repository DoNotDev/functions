// packages/functions/src/shared/oauth/exchangeToken.ts

/**
 * @fileoverview OAuth Token Exchange Algorithm
 * @description Platform-agnostic algorithm for exchanging OAuth codes for tokens
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  ExchangeTokenRequest,
  TokenResponse,
} from '@donotdev/core/server';

/** Platform-agnostic provider for exchanging OAuth authorization codes for tokens. */
export interface OAuthProvider {
  exchangeCodeForToken(params: {
    code: string;
    redirectUri: string;
    codeVerifier?: string;
  }): Promise<TokenResponse>;
}

/**
 * Exchange OAuth code for token
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function exchangeTokenAlgorithm(
  request: ExchangeTokenRequest,
  oauthProvider: OAuthProvider
): Promise<TokenResponse> {
  const { code, redirectUri, codeVerifier } = request;

  // Exchange code for token
  const tokenResponse = await oauthProvider.exchangeCodeForToken({
    code,
    redirectUri,
    codeVerifier,
  });

  return tokenResponse;
}
