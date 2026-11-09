// packages/functions/src/supabase/billing/stripeWebhook.ts

/**
 * @fileoverview Stripe webhook Supabase Edge Function
 * @description Verifies and routes Stripe webhook events through the shared
 * processWebhook (SSOT). Idempotency is stored in Postgres (`webhook_events`).
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type { StripeBackConfig } from '@donotdev/core/server';

import { updateUserSubscription } from '../../shared/billing/helpers/updateUserSubscription.js';
import { createSupabaseIdempotencyStore } from '../../shared/billing/supabaseIdempotency.js';
import { processWebhook } from '../../shared/billing/webhookHandler.js';
import { initStripe, stripe } from '../../shared/billing/stripeClient.js';
import { createEdgeFunction } from '../edgeFunction.js';
import { createSupabaseAuthProvider } from '../helpers/authProvider.js';

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;

function getEnvOrThrow(key: string): string {
  const value =
    typeof Deno !== 'undefined' ? Deno.env.get(key) : process.env[key];
  if (!value) throw new Error(`Missing ${key} environment variable`);
  return value;
}

/**
 * Create a Supabase Edge Function handler for Stripe webhooks.
 * Requires the `webhook_events` migration (see `WEBHOOK_EVENTS_SQL`).
 * Deploy with JWT verification disabled for this function: Stripe authenticates
 * with its signature, not a Supabase JWT.
 * Any failure answers non-2xx so Stripe retries the event.
 *
 * @example
 * ```typescript
 * // supabase/functions/stripe-webhook/index.ts
 * import { createStripeWebhook } from '@donotdev/functions/supabase';
 * import { billingConfig } from '../_shared/billingConfig.ts';
 *
 * Deno.serve(createStripeWebhook(billingConfig));
 * ```
 *
 * @param billingConfig - App back config
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function createStripeWebhook(billingConfig: StripeBackConfig) {
  return createEdgeFunction(
    async (req, ctx) => {
      const signature = req.headers.get('stripe-signature');
      if (!signature) return ctx.error('Missing Stripe signature', 400);

      initStripe(getEnvOrThrow('STRIPE_SECRET_KEY'));

      const result = await processWebhook(
        await req.text(),
        signature,
        getEnvOrThrow('STRIPE_WEBHOOK_SECRET'),
        stripe,
        billingConfig,
        updateUserSubscription,
        createSupabaseAuthProvider(ctx.supabaseAdmin),
        createSupabaseIdempotencyStore(ctx.supabaseAdmin)
      );

      return ctx.json({ received: true, message: result.message });
    },
    { requireAuth: false, extraHeaders: ['stripe-signature'] }
  );
}
