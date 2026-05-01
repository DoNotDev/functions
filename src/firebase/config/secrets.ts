// packages/functions/src/firebase/config/secrets.ts

/**
 * @fileoverview Firebase Functions V2 Secrets
 * @description Definition of secrets using the modern defineSecret API
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { defineSecret } from 'firebase-functions/params';

/**
 * Stripe Secret Key
 * Used for server-side Stripe API operations
 */
export const stripeSecretKey = defineSecret('STRIPE_SECRET_KEY');

/**
 * Stripe Webhook Secret
 * Used to verify signatures of incoming Stripe webhooks
 */
export const stripeWebhookSecret = defineSecret('STRIPE_WEBHOOK_SECRET');

/**
 * GitHub Personal Access Token
 * Used for GitHub API operations (repo access, etc.)
 */
export const githubPersonalAccessToken = defineSecret(
  'GITHUB_PERSONAL_ACCESS_TOKEN'
);
