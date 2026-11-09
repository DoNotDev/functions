// packages/functions/src/shared/billing/__tests__/checkoutValidation.test.ts

/**
 * @fileoverview Tests for checkout validation (Stripe limits, inclusive tax rates)
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';
import { describe, it, expect, vi } from 'vitest';

import { StripeOrderShippingSchema } from '@donotdev/core/server';
import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
  StripeOrderBackItem,
} from '@donotdev/core/server';

import { assertCheckoutSessionMetadata } from '../checkoutValidation.js';
import { createCheckoutAlgorithm } from '../createCheckout.js';
import type { StripeCheckoutProvider } from '@donotdev/core/server';

import type { AuthCheckoutProvider, StripeSessionProvider } from '../createCheckout.js';

const USER_ID = 'user_001';
const URLS = {
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
};

const auth: AuthCheckoutProvider = {
  getUser: vi.fn(async () => ({ customClaims: {} })),
};

function makeSessionProvider(inclusiveIds: string[] = []) {
  const createStripeSession = vi.fn<StripeSessionProvider['createStripeSession']>(
    async () => ({ id: 'cs_1', url: 'https://checkout.stripe.com/c/cs_1' })
  );
  const retrieveTaxRate = vi.fn<StripeSessionProvider['retrieveTaxRate']>(
    async (id) => ({ id, inclusive: inclusiveIds.includes(id) })
  );
  return { createStripeSession, retrieveTaxRate };
}

function makeConfig(order: Partial<StripeOrderBackItem> = {}): StripeBackConfig {
  return {
    pro: {
      type: 'StripeSubscription',
      name: 'Pro',
      price: 1999,
      currency: 'eur',
      priceId: 'price_pro',
      tier: 'pro',
      duration: '1month',
    },
    shop: {
      type: 'StripeOrder',
      name: 'Shop',
      currency: 'eur',
      tax: { mode: 'manual', taxRateIds: ['txr_val_20'] },
      taxIdCollection: 'optional',
      billingAddressCollection: 'required',
      customerCreation: 'always',
      invoiceCreation: true,
      resolveLineItems: vi.fn(async () => ({
        orderId: 'ord_1',
        lineItems: [{ productId: 'p', name: 'P', unitAmount: 1000, quantity: 1 }],
      })),
      onOrderPaid: vi.fn(async () => {}),
      ...order,
    },
  };
}

const PRO: CreateCheckoutSessionRequest = {
  billingConfigKey: 'pro',
  lineItems: [{ productId: 'pro', quantity: 1 }],
  ...URLS,
};
const SHOP: CreateCheckoutSessionRequest = {
  billingConfigKey: 'shop',
  lineItems: [{ productId: 'p', quantity: 1 }],
  ...URLS,
};

describe('Stripe metadata limits', () => {
  it.each([
    ['51 keys incl. server keys', Object.fromEntries(Array.from({ length: 49 }, (_, i) => [`k${i}`, 'v'])), /at most 50/],
    ['41-char key', { ['k'.repeat(41)]: 'v' }, /too long \(max 40/],
    ['square brackets in key', { 'a[b]': 'v' }, /square brackets/],
    ['501-char value', { note: 'x'.repeat(501) }, /too long \(max 500/],
  ])('rejects %s before calling Stripe (single-price and 0.1.x provider)', async (_l, metadata, error) => {
    const stripe = makeSessionProvider();
    await expect(
      createCheckoutAlgorithm({ ...PRO, metadata }, USER_ID, stripe, auth, makeConfig())
    ).rejects.toThrow(error);
    expect(stripe.createStripeSession).not.toHaveBeenCalled();

    const legacy = { createCheckoutSession: vi.fn<StripeCheckoutProvider['createCheckoutSession']>() };
    await expect(
      createCheckoutAlgorithm({ ...PRO, metadata }, USER_ID, legacy, auth, makeConfig())
    ).rejects.toThrow(error);
    expect(legacy.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('accepts metadata at the limits (48 client keys + userId + billingConfigKey, 40/500 chars)', async () => {
    const metadata = Object.fromEntries(
      Array.from({ length: 48 }, (_, i) => [`${i}`.padEnd(40, 'k'), 'v'.repeat(500)])
    );
    const stripe = makeSessionProvider();
    await createCheckoutAlgorithm({ ...PRO, metadata }, USER_ID, stripe, auth, makeConfig());
    expect(stripe.createStripeSession).toHaveBeenCalledTimes(1);
  });

  it('StripeOrder: counts orderId and fails before resolveLineItems creates an order', async () => {
    const config = makeConfig();
    const metadata = Object.fromEntries(Array.from({ length: 48 }, (_, i) => [`k${i}`, 'v']));
    await expect(
      createCheckoutAlgorithm({ ...SHOP, metadata }, USER_ID, makeSessionProvider(), auth, config)
    ).rejects.toThrow(/at most 50/);
    expect((config.shop as StripeOrderBackItem).resolveLineItems).not.toHaveBeenCalled();
  });

  it('checks every metadata map of the session params', () => {
    expect(() =>
      assertCheckoutSessionMetadata({
        mode: 'payment',
        metadata: { ok: 'v' },
        payment_intent_data: { metadata: { ['x'.repeat(41)]: 'v' } },
      })
    ).toThrow(/payment_intent_data\.metadata/);
    expect(() =>
      assertCheckoutSessionMetadata({
        mode: 'payment',
        line_items: [
          {
            price_data: {
              currency: 'eur',
              unit_amount: 1,
              product_data: { name: 'n', metadata: { productId: 'y'.repeat(501) } },
            },
            quantity: 1,
          },
        ],
      })
    ).toThrow(/line_items\[0\]\.price_data\.product_data\.metadata/);
  });
});

describe('StripeOrder manual tax: inclusive Tax Rates', () => {
  it('rejects an inclusive Tax Rate before resolving lines', async () => {
    const config = makeConfig({ tax: { mode: 'manual', taxRateIds: ['txr_val_incl'] } });
    const stripe = makeSessionProvider(['txr_val_incl']);
    await expect(
      createCheckoutAlgorithm(SHOP, USER_ID, stripe, auth, config)
    ).rejects.toThrow(/Tax Rate 'txr_val_incl' is inclusive/);
    expect((config.shop as StripeOrderBackItem).resolveLineItems).not.toHaveBeenCalled();
    expect(stripe.createStripeSession).not.toHaveBeenCalled();
  });

  it('retrieves each Tax Rate once per instance', async () => {
    const config = makeConfig({ tax: { mode: 'manual', taxRateIds: ['txr_val_once'] } });
    const stripe = makeSessionProvider();
    await createCheckoutAlgorithm(SHOP, USER_ID, stripe, auth, config);
    await createCheckoutAlgorithm(SHOP, USER_ID, stripe, auth, config);
    expect(stripe.retrieveTaxRate).toHaveBeenCalledTimes(1);
    expect(stripe.createStripeSession).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed lookup', async () => {
    const config = makeConfig({ tax: { mode: 'manual', taxRateIds: ['txr_val_flaky'] } });
    const stripe = makeSessionProvider();
    stripe.retrieveTaxRate.mockRejectedValueOnce(new Error('stripe down'));
    await expect(createCheckoutAlgorithm(SHOP, USER_ID, stripe, auth, config)).rejects.toThrow(
      'stripe down'
    );
    await createCheckoutAlgorithm(SHOP, USER_ID, stripe, auth, config);
    expect(stripe.retrieveTaxRate).toHaveBeenCalledTimes(2);
  });

  it('automatic tax does not retrieve Tax Rates', async () => {
    const stripe = makeSessionProvider();
    await createCheckoutAlgorithm(SHOP, USER_ID, stripe, auth, makeConfig({ tax: { mode: 'automatic' } }));
    expect(stripe.retrieveTaxRate).not.toHaveBeenCalled();
  });
});

describe('StripeOrder Stripe limits', () => {
  it('orderId (client_reference_id) is capped at 200 characters', async () => {
    const config = makeConfig({
      resolveLineItems: vi.fn(async () => ({
        orderId: 'o'.repeat(201),
        lineItems: [{ productId: 'p', name: 'P', unitAmount: 1000, quantity: 1 }],
      })),
    });
    await expect(
      createCheckoutAlgorithm(SHOP, USER_ID, makeSessionProvider(), auth, config)
    ).rejects.toThrow(/client_reference_id \(max 200/);
  });

  it('allowedCountries: uppercase ISO 3166-1 alpha-2 only', () => {
    expect(v.safeParse(StripeOrderShippingSchema, { allowedCountries: ['FR', 'BE'] }).success).toBe(true);
    for (const code of ['fr', 'F1', 'FRA', 'Fr']) {
      expect(v.safeParse(StripeOrderShippingSchema, { allowedCountries: [code] }).success).toBe(false);
    }
  });

  it('shippingRateIds: at most 5', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `shr_${i}`);
    expect(
      v.safeParse(StripeOrderShippingSchema, { allowedCountries: ['FR'], shippingRateIds: ids(5) }).success
    ).toBe(true);
    expect(
      v.safeParse(StripeOrderShippingSchema, { allowedCountries: ['FR'], shippingRateIds: ids(6) }).success
    ).toBe(false);
  });
});
