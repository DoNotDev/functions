// packages/functions/src/firebase/oauth/providerSecrets.ts

/**
 * @fileoverview OAuth provider secrets for the token callables
 * @description Validates the providers an app enables and declares one
 * `${PROVIDER}_CLIENT_SECRET` secret per provider, so the deploy binds exactly
 * those to the function. `${PROVIDER}_CLIENT_ID` is not a secret: it stays
 * plain config in functions/.env.
 *
 * @version 0.1.0
 * @since 0.3.2
 * @author AMBROISE PARK Consulting
 */

import { defineSecret } from 'firebase-functions/params';
import type { SecretParam } from 'firebase-functions/params';

import { OAUTH_PARTNERS, type OAuthPartnerId } from '@donotdev/core/server';

/** Providers a token callable serves and the secrets it declares for them. */
export interface OAuthProviderSecrets {
  /** Enabled providers; a request for any other provider is rejected. */
  allowed: ReadonlySet<string>;
  /** One `${PROVIDER}_CLIENT_SECRET` per enabled provider. */
  secrets: SecretParam[];
}

/**
 * Validate the providers a token callable serves and declare their client secrets.
 *
 * @param providers - OAuth partner ids from `OAUTH_PARTNERS` (at least one)
 * @param factory - Factory name, used in error messages
 * @returns Enabled providers and their declared secrets
 * @throws Error when `providers` is empty or lists an id `OAUTH_PARTNERS` does not have
 *
 * @version 0.1.0
 * @since 0.3.2
 * @author AMBROISE PARK Consulting
 */
export function defineOAuthProviderSecrets(
  providers: readonly OAuthPartnerId[],
  factory: string
): OAuthProviderSecrets {
  if (!Array.isArray(providers) || providers.length === 0) {
    throw new Error(
      `${factory}: providers is required and must list at least one OAuth provider (${Object.keys(OAUTH_PARTNERS).join(', ')}).`
    );
  }
  const allowed = new Set<string>();
  for (const provider of providers) {
    if (
      typeof provider !== 'string' ||
      !Object.hasOwn(OAUTH_PARTNERS, provider)
    ) {
      throw new Error(
        `${factory}: unknown OAuth provider "${String(provider)}". Known providers: ${Object.keys(OAUTH_PARTNERS).join(', ')}.`
      );
    }
    allowed.add(provider);
  }
  const secrets = [...allowed].map((provider) =>
    defineSecret(`${provider.toUpperCase()}_CLIENT_SECRET`)
  );
  return { allowed, secrets };
}
