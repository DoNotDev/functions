// packages/functions/src/shared/oauth/grantAccess.ts

/**
 * @fileoverview Grant OAuth Access Algorithm
 * @description Platform-agnostic algorithm for granting OAuth access
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/** Platform-agnostic provider for granting OAuth access to a user. */
export interface OAuthGrantProvider {
  grantAccess(params: {
    userId: string;
    provider: string;
    accessToken: string;
    refreshToken?: string;
  }): Promise<{ success: boolean; message: string }>;
}

/**
 * Grant OAuth access to user
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function grantAccessAlgorithm(
  userId: string,
  provider: string,
  accessToken: string,
  refreshToken: string | undefined,
  oauthProvider: OAuthGrantProvider
): Promise<{ success: boolean; message: string }> {
  const result = await oauthProvider.grantAccess({
    userId,
    provider,
    accessToken,
    refreshToken,
  });

  return result;
}
