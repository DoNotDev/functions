// packages/functions/src/supabase/billing/changePlan.ts

/**
 * @fileoverview Change Plan — Supabase Edge Function
 * @description Wraps the shared `changeUserPlan` for Supabase.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { hasRoleAccess, type StripeBackConfig } from '@donotdev/core/server';

import { changeUserPlan } from '../../shared/billing/helpers/subscriptionManagement.js';
import { initStripe } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { createSupabaseAuthProvider } from '../helpers/authProvider.js';

// =============================================================================
// Schema
// =============================================================================

const changePlanSchema = v.object({
  userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
  newPriceId: v.pipe(v.string(), v.minLength(1, 'Price ID is required')),
  billingConfigKey: v.pipe(
    v.string(),
    v.minLength(1, 'Billing config key is required')
  ),
});

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler for plan changes.
 *
 * @param billingConfig - Billing configuration with product definitions
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createChangePlan(billingConfig: StripeBackConfig) {
  return createSupabaseHandler(
    'change-plan',
    changePlanSchema,
    async (data, ctx) => {
      // Non-admin users can only change their own plan
      if (!hasRoleAccess(ctx.userRole, 'admin') && data.userId !== ctx.uid) {
        throw new Error("Forbidden: cannot change another user's plan");
      }

      initStripe(getStripeKey());
      const authProvider = createSupabaseAuthProvider(ctx.supabaseAdmin);
      return changeUserPlan(
        data.userId,
        data.newPriceId,
        data.billingConfigKey,
        billingConfig,
        authProvider
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
