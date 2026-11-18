import { describe, expect, expectTypeOf, it } from 'vitest';
import type Stripe from 'stripe';

import * as shared from '../../index.js';
import * as supabase from '../../../supabase/index.js';
import type { StripeSessionProvider } from '../createCheckout.js';
import type { VerifyOrderCheckoutDependencies } from '../verifyOrderCheckout.js';
import { verifyOrderCheckoutAlgorithm } from '../verifyOrderCheckout.js';
import { createCheckoutAlgorithm } from '../createCheckout.js';
import { handleOrderSessionEvent } from '../orderWebhook.js';
import { createCheckoutSession } from '../../../supabase/billing/createCheckoutSession.js';
import { createStripeWebhook } from '../../../supabase/billing/stripeWebhook.js';
import type {
  ProcessPaymentSuccessRequest,
  ProcessPaymentSuccessResponse,
} from '@donotdev/core/server';

describe('checkout verification additive public exports', () => {
  it('exposes the same algorithm through shared and Supabase entry points', () => {
    expect(shared.verifyOrderCheckoutAlgorithm).toBe(verifyOrderCheckoutAlgorithm);
    expect(supabase.verifyOrderCheckoutAlgorithm).toBe(verifyOrderCheckoutAlgorithm);
    expectTypeOf<supabase.VerifyOrderCheckoutDependencies>().toEqualTypeOf<VerifyOrderCheckoutDependencies>();
    expectTypeOf<shared.OrderCheckoutBinding>().toEqualTypeOf<supabase.OrderCheckoutBinding>();
  });

  it('preserves existing checkout and webhook exports', () => {
    expect(shared.createCheckoutAlgorithm).toBe(createCheckoutAlgorithm);
    expect(supabase.createCheckoutAlgorithm).toBe(createCheckoutAlgorithm);
    expect(shared.handleOrderSessionEvent).toBe(handleOrderSessionEvent);
    expect(supabase.createCheckoutSession).toBe(createCheckoutSession);
    expect(supabase.createStripeWebhook).toBe(createStripeWebhook);
  });

  it('keeps retrieval separate from existing creation providers and legacy success declarations', () => {
    const provider: StripeSessionProvider = {
      createStripeSession: async () => ({ id: 'cs_created', url: null }),
      retrieveTaxRate: async (id) => ({ id, inclusive: false }),
    };
    expect(Object.keys(provider)).toEqual(['createStripeSession', 'retrieveTaxRate']);
    expectTypeOf<StripeSessionProvider>().toEqualTypeOf<supabase.StripeSessionProvider>();
    expectTypeOf<VerifyOrderCheckoutDependencies['retrieveStripeSession']>().toEqualTypeOf<
      (id: string) => Promise<Pick<Stripe.Checkout.Session, 'id' | 'mode' | 'status' | 'payment_status' | 'metadata'>>
    >();
    expectTypeOf<ProcessPaymentSuccessRequest>().toEqualTypeOf<{ sessionId: string }>();
    expectTypeOf<ProcessPaymentSuccessResponse>().toEqualTypeOf<{ success: boolean; sessionId: string }>();
  });
});
