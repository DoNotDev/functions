// packages/functions/src/shared/billing/apiVersion.ts

/**
 * @fileoverview Stripe API version pin
 * @description Single source of truth for the Stripe API version the framework
 * reads. The subscription handlers still read pre-basil fields
 * (`invoice.subscription`, `subscription.current_period_end`), so the pin stays
 * on acacia; StripeOrder needs `collected_information` (2025-02-24.acacia).
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

/**
 * Stripe API version used by `initStripe` when `STRIPE_API_VERSION` is unset,
 * and the oldest version whose Checkout Session payload StripeOrder can read.
 * Webhook event payloads follow the webhook ENDPOINT's API version (set when
 * the endpoint is created in the Dashboard or API), not this value.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const STRIPE_API_VERSION_PIN = '2025-02-24.acacia';
