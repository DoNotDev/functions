// packages/functions/src/shared/billing/checkoutPrice.ts

/**
 * @fileoverview Single-price checkout (StripePayment / StripeSubscription)
 * @description 0.1.x pricing rules and the 0.1.x params → Stripe params mapping
 * used by `createCheckoutAlgorithm`.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import type {
  CheckoutMode,
  CheckoutSessionParams,
  CreateCheckoutSessionRequest,
  StripePaymentBackItem,
  StripeSubscriptionBackItem,
} from '@donotdev/core/server';


/** Price resolved for a single-price item (0.1.x rules). */
export interface PricePlan {
  /** Price charged */
  priceId: string;
  mode: CheckoutMode;
}

/**
 * 0.1.x pricing for StripePayment/StripeSubscription: a request priceId (must
 * match the config priceId when set), else the back-config priceId.
 */
export function resolvePricePlan(
  item: StripePaymentBackItem | StripeSubscriptionBackItem,
  request: CreateCheckoutSessionRequest
): PricePlan {
  const { billingConfigKey: key, priceId } = request;
  const [line] = request.lineItems;
  if (
    request.lineItems.length !== 1 ||
    !line ||
    line.productId !== key ||
    line.quantity !== 1
  ) {
    throw new Error(
      `'${key}' is a single-price item: lineItems must be [{ productId: '${key}', quantity: 1 }]`
    );
  }

  const mode: CheckoutMode =
    request.mode ?? (item.type === 'StripeSubscription' ? 'subscription' : 'payment');

  if (priceId) {
    if (item.priceId && item.priceId !== priceId) {
      throw new Error('Price ID mismatch with configuration');
    }
    return { priceId, mode };
  }

  if (!item.priceId) {
    throw new Error(
      `'${key}' has no priceId in the back config: set one, send a priceId, or use StripeOrder for server-priced lines`
    );
  }
  return { priceId: item.priceId, mode };
}

/** 0.1.x params → Stripe params (what the 0.1.x Firebase/Supabase providers sent). */
export function toStripeSessionParams(
  params: CheckoutSessionParams
): Stripe.Checkout.SessionCreateParams {
  const mode = params.mode || 'payment';
  return {
    mode,
    line_items: [
      { price: params.priceId, quantity: 1 },
    ],
    allow_promotion_codes: params.allowPromotionCodes,
    success_url: params.successUrl,
    cancel_url: params.cancelUrl,
    customer_email: params.customerEmail,
    metadata: params.metadata,
    // Renewal/cancellation events read the subscription's own metadata
    ...(mode === 'subscription' && {
      subscription_data: { metadata: params.metadata },
    }),
  };
}
