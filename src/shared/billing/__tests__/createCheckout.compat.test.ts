// packages/functions/src/shared/billing/__tests__/createCheckout.compat.test.ts

/**
 * @fileoverview 0.1.x regression tests for createCheckoutAlgorithm
 * @description Reproduces 0.1.x usage: back-config items without priceId
 * (client priceId, dynamic pricing), beforeCheckout guards on 0.1.x options,
 * and the 0.1.x call shape / StripeCheckoutProvider.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';
import { describe, it, expect, vi } from 'vitest';

import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import type {
  BeforeCheckoutHook,
  CheckoutOptions,
  StripeBackConfig,
} from '@donotdev/core/server';

import { createCheckoutAlgorithm } from '../createCheckout.js';
import type { StripeCheckoutProvider } from '@donotdev/core/server';

import type { AuthCheckoutProvider, StripeSessionProvider } from '../createCheckout.js';

const USER_ID = 'user_001';
const URLS = {
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
};

/** 0.1.x back config: no priceId, client-supplied price. */
function makeLegacyConfig(
  beforeCheckout?: BeforeCheckoutHook
): StripeBackConfig {
  return {
    credits: {
      type: 'StripePayment',
      name: 'Credits',
      price: 0,
      currency: 'eur',
      tier: 'credits',
      duration: 'lifetime',
      beforeCheckout,
    },
    pro_monthly: {
      type: 'StripeSubscription',
      name: 'Pro Monthly',
      price: 1999,
      currency: 'eur',
      tier: 'pro',
      duration: '1month',
      beforeCheckout,
    },
  };
}

/** 0.1.x client request (as sent by @donotdev/billing 0.1.x), validated by the real schema. */
function legacyRequest(fields: Record<string, unknown>) {
  return v.parse(CreateCheckoutSessionRequestSchema, {
    ...URLS,
    allowPromotionCodes: true,
    ...fields,
  });
}

function makeLegacyProvider() {
  const createCheckoutSession = vi.fn<
    StripeCheckoutProvider['createCheckoutSession']
  >(async () => ({ id: 'cs_legacy', url: 'https://checkout.stripe.com/c/cs_legacy' }));
  return { createCheckoutSession };
}

function makeSessionProvider() {
  const createStripeSession = vi.fn<StripeSessionProvider['createStripeSession']>(
    async () => ({ id: 'cs_new', url: 'https://checkout.stripe.com/c/cs_new' })
  );
  const retrieveTaxRate = vi.fn<StripeSessionProvider['retrieveTaxRate']>(
    async (id) => ({ id, inclusive: false })
  );
  return { createStripeSession, retrieveTaxRate };
}

const auth: AuthCheckoutProvider = {
  getUser: vi.fn(async () => ({ customClaims: {} })),
};

// ---------------------------------------------------------------------------
// (a) back-config item without priceId
// ---------------------------------------------------------------------------

describe('0.1.x (a): back-config item without priceId', () => {
  it('uses the client priceId', async () => {
    const stripe = makeSessionProvider();
    const request = legacyRequest({
      priceId: 'price_client',
      mode: 'subscription',
      metadata: { billingConfigKey: 'pro_monthly' },
    });
    await createCheckoutAlgorithm(request, USER_ID, stripe, auth, makeLegacyConfig());
    expect(stripe.createStripeSession.mock.calls[0]?.[0]).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_client', quantity: 1 }],
      subscription_data: { metadata: { userId: USER_ID, billingConfigKey: 'pro_monthly' } },
    });
  });

});

// ---------------------------------------------------------------------------
// (b) beforeCheckout second argument
// ---------------------------------------------------------------------------

describe('0.1.x (b): beforeCheckout options', () => {
  it('receives priceId / mode / currency, plus the new fields', async () => {
    const hook = vi.fn<BeforeCheckoutHook>(async () => ({ allowed: true }));
    const request = legacyRequest({
      priceId: 'price_client',
      currency: 'usd',
      mode: 'payment',
      metadata: { billingConfigKey: 'credits' },
    });
    await createCheckoutAlgorithm(request, USER_ID, makeSessionProvider(), auth, makeLegacyConfig(hook));
    expect(hook.mock.calls[0]?.[1]).toMatchObject({
      priceId: 'price_client',
      mode: 'payment',
      currency: 'usd',
      allowPromotionCodes: true,
      metadata: { billingConfigKey: 'credits' },
      billingConfigKey: 'credits',
      lineItems: [{ productId: 'credits', quantity: 1 }],
      userId: USER_ID,
    });
  });

  it('a 0.1.x guard on options.mode still blocks', async () => {
    // 0.1.x hook typed with CheckoutOptions keeps compiling
    const guard = async (_userId: string, options: CheckoutOptions) =>
      options.mode === 'subscription'
        ? { allowed: false, reason: 'Subscriptions closed' }
        : { allowed: true };
    const config = makeLegacyConfig(guard);
    const priced = legacyRequest({
      priceId: 'price_client',
      metadata: { billingConfigKey: 'pro_monthly' },
    });
    // mode omitted: derived from the StripeSubscription item type
    await expect(
      createCheckoutAlgorithm(priced, USER_ID, makeSessionProvider(), auth, config)
    ).rejects.toThrow('Subscriptions closed');
    // New-shape request on a configured price: mode + priceId still populated
    const hook = vi.fn<BeforeCheckoutHook>(async () => ({ allowed: true }));
    const withPrice = makeLegacyConfig(hook);
    (withPrice.pro_monthly as { priceId?: string }).priceId = 'price_pro';
    await createCheckoutAlgorithm(
      { billingConfigKey: 'pro_monthly', ...URLS },
      USER_ID,
      makeSessionProvider(),
      auth,
      withPrice
    );
    expect(hook.mock.calls[0]?.[1]).toMatchObject({
      mode: 'subscription',
      priceId: 'price_pro',
    });
  });
});

// ---------------------------------------------------------------------------
// (c) 0.1.x call shape and StripeCheckoutProvider
// ---------------------------------------------------------------------------

describe('0.1.x (c): createCheckoutAlgorithm(request, provider, auth, config)', () => {
  it('sends the exact 0.1.x params to a 0.1.x provider, userId from the request', async () => {
    const stripe = makeLegacyProvider();
    const result = await createCheckoutAlgorithm(
      {
        priceId: 'price_client',
        userId: USER_ID,
        mode: 'subscription',
        customerEmail: 'a@b.co',
        metadata: { billingConfigKey: 'pro_monthly', ref: 'x' },
        ...URLS,
      },
      stripe,
      auth,
      makeLegacyConfig()
    );
    expect(result).toEqual({
      sessionId: 'cs_legacy',
      sessionUrl: 'https://checkout.stripe.com/c/cs_legacy',
    });
    expect(stripe.createCheckoutSession).toHaveBeenCalledWith({
      priceId: 'price_client',
      currency: 'eur',
      customerEmail: 'a@b.co',
      metadata: { billingConfigKey: 'pro_monthly', ref: 'x', userId: USER_ID },
      allowPromotionCodes: true,
      successUrl: URLS.successUrl,
      cancelUrl: URLS.cancelUrl,
      mode: 'subscription',
    });
  });

  it('0.1.x call shape requires request.userId', async () => {
    await expect(
      createCheckoutAlgorithm(
        { priceId: 'price_client', metadata: { billingConfigKey: 'credits' }, ...URLS },
        makeLegacyProvider(),
        auth,
        makeLegacyConfig()
      )
    ).rejects.toThrow('Missing userId in request');
  });

  it('StripeOrder needs a StripeSessionProvider', async () => {
    const config: StripeBackConfig = {
      shop: {
        type: 'StripeOrder',
        name: 'Shop',
        currency: 'eur',
        tax: { mode: 'automatic' },
        taxIdCollection: 'disabled',
        billingAddressCollection: 'auto',
        customerCreation: 'if_required',
        invoiceCreation: false,
        resolveLineItems: vi.fn(),
        onOrderPaid: vi.fn(),
      },
    };
    await expect(
      createCheckoutAlgorithm(
        { billingConfigKey: 'shop', userId: USER_ID, ...URLS },
        makeLegacyProvider(),
        auth,
        config
      )
    ).rejects.toThrow(/StripeSessionProvider/);
  });
});
