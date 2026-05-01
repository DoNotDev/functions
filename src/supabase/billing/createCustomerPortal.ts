// packages/functions/src/supabase/billing/createCustomerPortal.ts

/**
 * @fileoverview Create Customer Portal — Supabase Edge Function
 * @description Wraps the shared `createCustomerPortalSession` for Supabase.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { createCustomerPortalSession } from '../../shared/billing/helpers/subscriptionManagement.js';
import { initStripe } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { createSupabaseAuthProvider } from '../helpers/authProvider.js';

// =============================================================================
// Schema
// =============================================================================

const customerPortalSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
  returnUrl: v.optional(v.pipe(v.string(), v.url())),
});

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler for Stripe Customer Portal.
 *
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createCustomerPortal() {
  return createSupabaseHandler(
    'create-customer-portal',
    customerPortalSchema,
    async (data, ctx) => {
      initStripe(getStripeKey());
      const authProvider = createSupabaseAuthProvider(ctx.supabaseAdmin);
      return createCustomerPortalSession(
        data.userId,
        authProvider,
        data.returnUrl
      );
    }
  );
}

function getStripeKey(): string {
  const key = (
    typeof Deno !== 'undefined'
      ? Deno.env.get('STRIPE_SECRET_KEY')
      : process.env.STRIPE_SECRET_KEY
  ) as string | undefined;
  if (!key) throw new Error('Missing STRIPE_SECRET_KEY environment variable');
  return key;
}

declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;
