// packages/functions/src/shared/billing/__tests__/createCheckout.test.ts

/**
 * @fileoverview Tests for createCheckoutAlgorithm
 * @description Unit tests using dependency injection — no real Stripe or Firebase calls.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';
import { describe, it, expect, vi } from 'vitest';

import { CreateCheckoutSessionRequestSchema } from '@donotdev/core/server';
import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
  StripeOrderBackItem,
} from '@donotdev/core/server';

import { createCheckoutAlgorithm } from '../createCheckout.js';
import type {
  StripeSessionProvider,
  AuthCheckoutProvider,
} from '../createCheckout.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const USER_ID = 'user_001';
const URLS = {
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
};

function makeOrderItem(
  overrides: Partial<StripeOrderBackItem> = {}
): StripeOrderBackItem {
  return {
    type: 'StripeOrder',
    name: 'Shop order',
    currency: 'eur',
    tax: { mode: 'manual', taxRateIds: ['txr_fr_20'] },
    taxIdCollection: 'optional',
    billingAddressCollection: 'required',
    customerCreation: 'always',
    invoiceCreation: true,
    resolveLineItems: vi.fn(async (items) => ({
      orderId: 'ord_42',
      lineItems: items.map((item) => ({
        productId: item.productId,
        name: `Product ${item.productId}`,
        unitAmount: 1250,
        quantity: item.quantity,
      })),
    })),
    onOrderPaid: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeConfig(order: StripeOrderBackItem = makeOrderItem()): StripeBackConfig {
  return {
    pro_monthly: {
      type: 'StripeSubscription',
      name: 'Pro Monthly',
      price: 1999,
      currency: 'EUR',
      priceId: 'price_pro',
      tier: 'pro',
      duration: '1month',
    },
    starter_once: {
      type: 'StripePayment',
      name: 'Starter Pack',
      price: 4900,
      currency: 'EUR',
      priceId: 'price_starter',
      tier: 'starter',
      duration: 'lifetime',
      allowPromotionCodes: true,
    },
    shop_order: order,
  };
}

function singleItemRequest(key: string): CreateCheckoutSessionRequest {
  return {
    billingConfigKey: key,
    lineItems: [{ productId: key, quantity: 1 }],
    ...URLS,
  };
}

const ORDER_REQUEST: CreateCheckoutSessionRequest = {
  billingConfigKey: 'shop_order',
  lineItems: [
    { productId: 'serum-30ml', quantity: 24 },
    { productId: 'toner-150ml', quantity: 12 },
  ],
  ...URLS,
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeStripeProvider() {
  const createStripeSession = vi.fn<
    StripeSessionProvider['createStripeSession']
  >(async () => ({
    id: 'cs_test_session123',
    url: 'https://checkout.stripe.com/pay/cs_test_session123',
  }));
  const retrieveTaxRate = vi.fn<StripeSessionProvider['retrieveTaxRate']>(
    async (id) => ({ id, inclusive: id.startsWith('txr_incl') })
  );
  return { createStripeSession, retrieveTaxRate };
}

function makeAuthProvider(): AuthCheckoutProvider {
  return { getUser: vi.fn(async () => ({ customClaims: {} })) };
}

async function run(
  request: CreateCheckoutSessionRequest,
  config: StripeBackConfig = makeConfig(),
  stripe = makeStripeProvider(),
  auth = makeAuthProvider()
) {
  const result = await createCheckoutAlgorithm(
    request,
    USER_ID,
    stripe,
    auth,
    config
  );
  const params = stripe.createStripeSession.mock.calls[0]?.[0];
  return { result, params, stripe, auth };
}

// ---------------------------------------------------------------------------
// Single-price items (StripePayment / StripeSubscription)
// ---------------------------------------------------------------------------

describe('createCheckoutAlgorithm — single-price items', () => {
  it('returns sessionId and sessionUrl', async () => {
    const { result } = await run(singleItemRequest('pro_monthly'));
    expect(result).toEqual({
      sessionId: 'cs_test_session123',
      sessionUrl: 'https://checkout.stripe.com/pay/cs_test_session123',
    });
  });

  it('subscription: config priceId, subscription mode, subscription metadata', async () => {
    const { params } = await run(singleItemRequest('pro_monthly'));
    expect(params).toMatchObject({
      mode: 'subscription',
      line_items: [{ price: 'price_pro', quantity: 1 }],
      subscription_data: {
        metadata: { userId: USER_ID, billingConfigKey: 'pro_monthly' },
      },
    });
  });

  it('payment: config priceId, payment mode', async () => {
    const { params } = await run(singleItemRequest('starter_once'));
    expect(params).toMatchObject({
      mode: 'payment',
      line_items: [{ price: 'price_starter', quantity: 1 }],
    });
    expect(params).not.toHaveProperty('subscription_data');
  });

  it('promotion codes: client choice, on by default (0.1.x behaviour)', async () => {
    expect((await run(singleItemRequest('pro_monthly'))).params?.allow_promotion_codes).toBe(true);
    expect(
      (await run({ ...singleItemRequest('pro_monthly'), allowPromotionCodes: false }))
        .params?.allow_promotion_codes
    ).toBe(false);
  });

  it('fails loud when the back config item has no priceId', async () => {
    const config = makeConfig();
    const { priceId: _omit, ...noPrice } = config.starter_once as any;
    config.starter_once = noPrice;
    await expect(run(singleItemRequest('starter_once'), config)).rejects.toThrow(
      /has no priceId/
    );
  });

  it('rejects any line other than [{ productId: key, quantity: 1 }]', async () => {
    await expect(
      run({
        ...singleItemRequest('starter_once'),
        lineItems: [{ productId: 'starter_once', quantity: 3 }],
      })
    ).rejects.toThrow(/single-price item/);
    await expect(
      run({
        ...singleItemRequest('starter_once'),
        lineItems: [{ productId: 'other', quantity: 1 }],
      })
    ).rejects.toThrow(/single-price item/);
  });
});

// ---------------------------------------------------------------------------
// StripeOrder
// ---------------------------------------------------------------------------

describe('createCheckoutAlgorithm — StripeOrder', () => {
  it('prices lines on the server and builds price_data excl. VAT with manual tax rates', async () => {
    const order = makeOrderItem();
    const { params } = await run(ORDER_REQUEST, makeConfig(order));

    expect(order.resolveLineItems).toHaveBeenCalledWith(ORDER_REQUEST.lineItems, {
      userId: USER_ID,
      billingConfigKey: 'shop_order',
      metadata: {},
    });
    expect(params?.mode).toBe('payment');
    expect(params?.line_items).toEqual([
      {
        price_data: {
          currency: 'eur',
          unit_amount: 1250,
          tax_behavior: 'exclusive',
          product_data: {
            name: 'Product serum-30ml',
            metadata: { productId: 'serum-30ml' },
          },
        },
        quantity: 24,
        tax_rates: ['txr_fr_20'],
      },
      {
        price_data: {
          currency: 'eur',
          unit_amount: 1250,
          tax_behavior: 'exclusive',
          product_data: {
            name: 'Product toner-150ml',
            metadata: { productId: 'toner-150ml' },
          },
        },
        quantity: 12,
        tax_rates: ['txr_fr_20'],
      },
    ]);
    expect(params?.automatic_tax).toEqual({ enabled: false });
  });

  it('applies the B2B options from the back config', async () => {
    const order = makeOrderItem({
      taxIdCollection: 'required',
      shipping: { allowedCountries: ['FR', 'BE'], shippingRateIds: ['shr_std'] },
      paymentMethodConfiguration: 'pmc_card_sepa',
    });
    const { params } = await run(ORDER_REQUEST, makeConfig(order));

    expect(params).toMatchObject({
      client_reference_id: 'ord_42',
      tax_id_collection: { enabled: true, required: 'if_supported' },
      billing_address_collection: 'required',
      shipping_address_collection: { allowed_countries: ['FR', 'BE'] },
      shipping_options: [{ shipping_rate: 'shr_std' }],
      customer_creation: 'always',
      invoice_creation: {
        enabled: true,
        invoice_data: {
          metadata: { userId: USER_ID, billingConfigKey: 'shop_order', orderId: 'ord_42' },
        },
      },
      payment_method_configuration: 'pmc_card_sepa',
      payment_intent_data: {
        metadata: { userId: USER_ID, billingConfigKey: 'shop_order', orderId: 'ord_42' },
      },
    });
  });

  it('automatic tax: Stripe Tax on, no tax_rates on lines', async () => {
    const order = makeOrderItem({ tax: { mode: 'automatic' } });
    const { params } = await run(ORDER_REQUEST, makeConfig(order));

    expect(params?.automatic_tax).toEqual({ enabled: true });
    for (const line of params?.line_items ?? []) {
      expect(line).not.toHaveProperty('tax_rates');
    }
  });

  it('disabled tax ID collection and no shipping', async () => {
    const order = makeOrderItem({ taxIdCollection: 'disabled', invoiceCreation: false });
    const { params } = await run(ORDER_REQUEST, makeConfig(order));

    expect(params?.tax_id_collection).toEqual({ enabled: false });
    expect(params?.invoice_creation).toEqual({ enabled: false });
    expect(params).not.toHaveProperty('shipping_address_collection');
    expect(params).not.toHaveProperty('payment_method_configuration');
  });

  it('server metadata (userId, billingConfigKey, orderId) cannot be overwritten by the client', async () => {
    const { params } = await run({
      ...ORDER_REQUEST,
      metadata: { userId: 'attacker', orderId: 'ord_fake', billingConfigKey: 'x', note: 'ok' },
    });
    expect(params?.metadata).toEqual({
      note: 'ok',
      userId: USER_ID,
      billingConfigKey: 'shop_order',
      orderId: 'ord_42',
    });
  });

  it.each([
    ['negative amount', { unitAmount: -1 }],
    ['fractional amount', { unitAmount: 12.5 }],
    ['zero quantity', { quantity: 0 }],
    ['empty name', { name: '' }],
  ])('fails loud on a malformed resolved line (%s)', async (_label, patch) => {
    const order = makeOrderItem({
      resolveLineItems: vi.fn(async () => ({
        orderId: 'ord_bad',
        lineItems: [
          { productId: 'p', name: 'P', unitAmount: 100, quantity: 1, ...patch },
        ],
      })),
    });
    const stripe = makeStripeProvider();
    await expect(run(ORDER_REQUEST, makeConfig(order), stripe)).rejects.toThrow();
    expect(stripe.createStripeSession).not.toHaveBeenCalled();
  });

  it('fails loud when the resolver returns no orderId', async () => {
    const order = makeOrderItem({
      resolveLineItems: vi.fn(async () => ({
        orderId: '',
        lineItems: [{ productId: 'p', name: 'P', unitAmount: 100, quantity: 1 }],
      })),
    });
    await expect(run(ORDER_REQUEST, makeConfig(order))).rejects.toThrow(/orderId/);
  });

  it('propagates resolver errors (unknown product, stock) without calling Stripe', async () => {
    const order = makeOrderItem({
      resolveLineItems: vi.fn(async () => {
        throw new Error('Unknown product: serum-30ml');
      }),
    });
    const stripe = makeStripeProvider();
    await expect(run(ORDER_REQUEST, makeConfig(order), stripe)).rejects.toThrow(
      'Unknown product: serum-30ml'
    );
    expect(stripe.createStripeSession).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// StripeOrder per-order session options (ResolvedOrder.session)
// ---------------------------------------------------------------------------

describe('createCheckoutAlgorithm — StripeOrder session options', () => {
  const line = { productId: 'p', name: 'P', unitAmount: 1000, quantity: 1 };
  const withSession = (session: object, overrides: Partial<StripeOrderBackItem> = {}) =>
    makeOrderItem({
      paymentMethodConfiguration: 'pmc_default',
      resolveLineItems: vi.fn(async () => ({ orderId: 'ord_1', lineItems: [line], session })),
      ...overrides,
    });

  it('per-order tax rates replace the configured ones; [] sends no tax_rates (reverse charge)', async () => {
    const replaced = await run(ORDER_REQUEST, makeConfig(withSession({ taxRateIds: ['txr_fr_55'] })));
    expect(replaced.params!.line_items![0]!.tax_rates).toEqual(['txr_fr_55']);
    const none = await run(ORDER_REQUEST, makeConfig(withSession({ taxRateIds: [] })));
    expect(none.params!.line_items![0]!.tax_rates).toBeUndefined();
  });

  it('rejects an inclusive per-order tax rate and per-order rates under automatic tax', async () => {
    await expect(
      run(ORDER_REQUEST, makeConfig(withSession({ taxRateIds: ['txr_incl_override'] })))
    ).rejects.toThrow(/inclusive/);
    await expect(
      run(ORDER_REQUEST, makeConfig(withSession({ taxRateIds: [] }, { tax: { mode: 'automatic' } })))
    ).rejects.toThrow(/tax.mode 'manual'/);
  });

  it('payment method types replace the configuration; expiry and invoice footer are set', async () => {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    const { params } = await run(
      ORDER_REQUEST,
      makeConfig(withSession({ paymentMethodTypes: ['sepa_debit'], expiresAt, invoiceFooter: 'Autoliquidation' }))
    );
    expect(params!.payment_method_types).toEqual(['sepa_debit']);
    expect(params!.payment_method_configuration).toBeUndefined();
    expect(params!.expires_at).toBe(expiresAt);
    expect(params!.invoice_creation!.invoice_data!.footer).toBe('Autoliquidation');
  });

  it('without session options the back config applies unchanged', async () => {
    const { params } = await run(ORDER_REQUEST, makeConfig(withSession({})));
    expect(params!.payment_method_configuration).toBe('pmc_default');
    expect(params!.payment_method_types).toBeUndefined();
    expect(params!.expires_at).toBeUndefined();
    expect(params!.line_items![0]!.tax_rates).toEqual(['txr_fr_20']);
  });

  it('fails loud on an expiry outside Stripe 30 min – 24 h, empty methods, or a footer without invoices', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(run(ORDER_REQUEST, makeConfig(withSession({ expiresAt: now + 60 })))).rejects.toThrow(/expiresAt/);
    await expect(run(ORDER_REQUEST, makeConfig(withSession({ expiresAt: now + 2 * 86400 })))).rejects.toThrow(/expiresAt/);
    await expect(run(ORDER_REQUEST, makeConfig(withSession({ paymentMethodTypes: [] })))).rejects.toThrow(/paymentMethodTypes/);
    await expect(
      run(ORDER_REQUEST, makeConfig(withSession({ invoiceFooter: 'x' }, { invoiceCreation: false })))
    ).rejects.toThrow(/invoiceCreation/);
  });
});

// ---------------------------------------------------------------------------
// Common validation
// ---------------------------------------------------------------------------

describe('createCheckoutAlgorithm — validation', () => {
  it('throws on an unknown billing config key', async () => {
    await expect(run(singleItemRequest('nope'))).rejects.toThrow(
      /Invalid billing config key/
    );
  });

  it('throws without an authenticated userId', async () => {
    await expect(
      createCheckoutAlgorithm(
        singleItemRequest('pro_monthly'),
        '',
        makeStripeProvider(),
        makeAuthProvider(),
        makeConfig()
      )
    ).rejects.toThrow(/userId/);
  });

  it('verifies the user before creating the session', async () => {
    const { auth } = await run(singleItemRequest('pro_monthly'));
    expect(auth.getUser).toHaveBeenCalledWith(USER_ID);
  });

  it('propagates getUser errors', async () => {
    const auth: AuthCheckoutProvider = {
      getUser: vi.fn(async () => {
        throw new Error('auth/user-not-found');
      }),
    };
    await expect(
      run(singleItemRequest('pro_monthly'), makeConfig(), makeStripeProvider(), auth)
    ).rejects.toThrow('auth/user-not-found');
  });

  it('beforeCheckout can block', async () => {
    const config = makeConfig(
      makeOrderItem({
        beforeCheckout: vi.fn(async () => ({ allowed: false, reason: 'Account not approved' })),
      })
    );
    await expect(run(ORDER_REQUEST, config)).rejects.toThrow('Account not approved');
  });

  it('rejects non-http redirect URLs', async () => {
    await expect(
      run({ ...singleItemRequest('pro_monthly'), successUrl: 'javascript:alert(1)' })
    ).rejects.toThrow(/Invalid success URL/);
  });

  it('rejects non-string metadata values', async () => {
    await expect(
      run({
        ...singleItemRequest('pro_monthly'),
        metadata: { n: 1 as unknown as string },
      })
    ).rejects.toThrow(/must be a string/);
  });

  it('propagates Stripe errors', async () => {
    const stripe = makeStripeProvider();
    stripe.createStripeSession.mockRejectedValueOnce(new Error('card_declined'));
    await expect(
      run(singleItemRequest('pro_monthly'), makeConfig(), stripe)
    ).rejects.toThrow('card_declined');
  });
});

// ---------------------------------------------------------------------------
// 0.1.x request compatibility (real schema)
// ---------------------------------------------------------------------------

describe('CreateCheckoutSessionRequestSchema — 0.1.x clients', () => {
  it('normalizes a 0.1.x request (key in metadata, priceId/mode kept) to the single line', async () => {
    const legacy = {
      priceId: 'price_pro',
      mode: 'subscription',
      userId: 'spoofed',
      ...URLS,
      metadata: { billingConfigKey: 'pro_monthly' },
      allowPromotionCodes: true,
    };
    const parsed = v.parse(CreateCheckoutSessionRequestSchema, legacy);
    expect(parsed.billingConfigKey).toBe('pro_monthly');
    expect(parsed.lineItems).toEqual([{ productId: 'pro_monthly', quantity: 1 }]);
    expect(parsed.priceId).toBe('price_pro');
    expect(parsed.mode).toBe('subscription');

    // userId argument wins over the client value
    const { params } = await run(parsed);
    expect(params?.line_items).toEqual([{ price: 'price_pro', quantity: 1 }]);
    expect(params?.metadata?.userId).toBe(USER_ID);
  });

  it('rejects a 0.1.x priceId that does not match the back config priceId', async () => {
    const parsed = v.parse(CreateCheckoutSessionRequestSchema, {
      priceId: 'price_client_supplied',
      ...URLS,
      metadata: { billingConfigKey: 'pro_monthly' },
    });
    await expect(run(parsed)).rejects.toThrow('Price ID mismatch with configuration');
  });

  it('rejects a request with no billingConfigKey anywhere', () => {
    const result = v.safeParse(CreateCheckoutSessionRequestSchema, {
      priceId: 'price_x',
      ...URLS,
    });
    expect(result.success).toBe(false);
  });

  it('keeps an explicit order request as sent', () => {
    const parsed = v.parse(CreateCheckoutSessionRequestSchema, ORDER_REQUEST);
    expect(parsed.lineItems).toEqual(ORDER_REQUEST.lineItems);
  });
});
