// packages/functions/src/shared/billing/__tests__/webhookHandler.test.ts

/**
 * @fileoverview Tests for Stripe webhook handler
 * @description Comprehensive tests for processWebhook, event routing, error handling,
 * state machine transitions, and idempotency behavior.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Deprecated auto-detected store (0.1.x call path) must resolve to in-memory
vi.mock('../../utils/detectFirestore.js', () => ({
  isFirestoreConfigured: vi.fn(() => false),
}));

// Mock firebase-functions (required by errorHandling.ts)
vi.mock('firebase-functions/v2/https', () => ({
  HttpsError: class HttpsError extends Error {
    code: string;
    details: any;
    constructor(code: string, message: string, details?: any) {
      super(message);
      this.code = code;
      this.details = details;
      this.name = 'HttpsError';
    }
  },
}));

// Mock @donotdev/core/server — provides validateStripeBackConfig, SUBSCRIPTION_STATUS, SUBSCRIPTION_TIERS
vi.mock('@donotdev/core/server', () => ({
  validateStripeBackConfig: vi.fn((config: unknown) => config),
  SUBSCRIPTION_STATUS: {
    ACTIVE: 'active',
    CANCELED: 'canceled',
    INCOMPLETE: 'incomplete',
    PAST_DUE: 'past_due',
    TRIALING: 'trialing',
    UNPAID: 'unpaid',
  },
  SUBSCRIPTION_TIERS: {
    FREE: 'free',
    PRO: 'pro',
    PREMIUM: 'premium',
  },
  DoNotDevError: class DoNotDevError extends Error {
    code: string;
    details?: Record<string, unknown>;
    constructor(
      message: string,
      code = 'internal',
      options?: { details?: Record<string, unknown> }
    ) {
      super(message);
      this.code = code;
      this.details = options?.details;
      this.name = 'DoNotDevError';
    }
  },
  // Fixed ISO string for deterministic assertions
  calculateSubscriptionEndDate: vi.fn(() => '2026-03-18T00:00:00.000Z'),
  EntityHookError: class EntityHookError extends Error {
    type: string;
    constructor(message: string, type: string) {
      super(message);
      this.type = type;
      this.name = 'EntityHookError';
    }
  },
}));

// Mock @donotdev/firebase/server (dynamic-imported by idempotency in Firestore mode)
vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: vi.fn(),
}));

// Mock logger to silence output in tests
vi.mock('../../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

import {
  createInMemoryIdempotencyStore,
  resetIdempotencyStore as resetLegacyIdempotencyStore,
} from '../idempotency.js';
import type { IdempotencyStore } from '../idempotency.js';
import { processWebhook } from '../webhookHandler.js';
import type { BillingAuthProvider, UpdateSubscriptionFn } from '@donotdev/core/server';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

/** Minimal StripeBackConfig with one StripePayment and one StripeSubscription item */
const makeConfig = (overrides: Record<string, any> = {}) => ({
  pro_monthly: {
    type: 'StripeSubscription' as const,
    name: 'Pro Monthly',
    price: 999,
    currency: 'usd',
    priceId: 'price_pro_monthly',
    tier: 'pro',
    duration: '1month',
    ...overrides,
  },
  lifetime_purchase: {
    type: 'StripePayment' as const,
    name: 'Lifetime',
    price: 19900,
    currency: 'usd',
    priceId: 'price_lifetime',
    tier: 'premium',
    duration: 'lifetime',
  },
});

/** Build a minimal Stripe event object (Checkout Sessions default to payment_status 'paid') */
function makeEvent(type: string, dataObject: Record<string, any>): any {
  if (type.startsWith('checkout.session.') && !('payment_status' in dataObject)) {
    dataObject = { ...dataObject, payment_status: 'paid' };
  }
  return {
    id: `evt_test_${Math.random().toString(36).slice(2)}`,
    type,
    data: { object: dataObject },
    created: Date.now() / 1000,
    livemode: false,
    pending_webhooks: 1,
    api_version: '2026-02-25.clover',
    object: 'event',
  };
}

/** Default mocked Stripe instance */
function makeStripe(eventOrFn?: any): any {
  return {
    webhooks: {
      constructEventAsync: vi.fn(async (_body, _sig, _secret) => {
        if (typeof eventOrFn === 'function') return eventOrFn();
        return eventOrFn;
      }),
    },
    subscriptions: {
      retrieve: vi.fn(),
    },
  };
}

/** Default mock auth provider */
function makeAuthProvider(): BillingAuthProvider {
  return {
    getUser: vi.fn(async () => ({ customClaims: {} })),
    setCustomUserClaims: vi.fn(async () => {}),
  };
}

/** Default mock updateSubscription */
function makeUpdateSubscription(): UpdateSubscriptionFn {
  return vi.fn(async () => {});
}

// Fresh store per test (beforeEach) so events are never pre-marked
let idempotencyStore: IdempotencyStore = createInMemoryIdempotencyStore();
function resetIdempotencyStore() {
  idempotencyStore = createInMemoryIdempotencyStore();
}

const RAW_BODY = 'raw-body-bytes';
const SIGNATURE = 'stripe-sig-header';
const WEBHOOK_SECRET = 'whsec_test_secret';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function callProcessWebhook({
  stripe,
  config = makeConfig(),
  updateSubscription = makeUpdateSubscription(),
  authProvider = makeAuthProvider(),
}: {
  stripe: any;
  config?: any;
  updateSubscription?: UpdateSubscriptionFn;
  authProvider?: BillingAuthProvider | null;
}) {
  return processWebhook(
    RAW_BODY,
    SIGNATURE,
    WEBHOOK_SECRET,
    stripe,
    config,
    updateSubscription,
    authProvider,
    idempotencyStore
  );
}

// ===========================================================================
// Test suites
// ===========================================================================

describe('processWebhook — signature verification', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls stripe.webhooks.constructEventAsync with raw body, signature and secret', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u1', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_abc',
      customer: 'cus_abc',
      payment_status: 'paid',
    });
    const stripe = makeStripe(event);
    const config = makeConfig();
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, config, updateSubscription });

    expect(stripe.webhooks.constructEventAsync).toHaveBeenCalledWith(
      RAW_BODY,
      SIGNATURE,
      WEBHOOK_SECRET
    );
  });

  it('throws when constructEventAsync rejects (invalid signature)', async () => {
    const stripe = {
      webhooks: {
        constructEventAsync: vi.fn(async () => {
          throw new Error(
            'No signatures found matching the expected signature'
          );
        }),
      },
      subscriptions: { retrieve: vi.fn() },
    };

    await expect(callProcessWebhook({ stripe })).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('processWebhook — idempotency', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns "already processed" without calling updateSubscription for duplicate event', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_dup', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_dup',
      customer: 'cus_dup',
    });
    const stripe = makeStripe(event);
    const updateSubscription = makeUpdateSubscription();

    // First call — processes normally
    await callProcessWebhook({ stripe, updateSubscription });

    // Reconstruct stripe mock returning the same event id (same event object)
    const stripe2 = makeStripe(event);
    const updateSubscription2 = makeUpdateSubscription();

    const result = await callProcessWebhook({
      stripe: stripe2,
      updateSubscription: updateSubscription2,
    });

    expect(result).toEqual({
      success: true,
      message: 'Event already processed',
    });
    expect(updateSubscription2).not.toHaveBeenCalled();
  });

  it('processes two different event ids independently', async () => {
    const config = makeConfig();
    const sessionPayload = {
      metadata: { userId: 'u_a', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_a',
      customer: 'cus_a',
    };
    const event1 = makeEvent('checkout.session.completed', sessionPayload);
    const event2 = makeEvent('checkout.session.completed', sessionPayload);
    // Ensure distinct ids
    event2.id = event1.id + '_b';

    const updateSubscription1 = makeUpdateSubscription();
    const updateSubscription2 = makeUpdateSubscription();

    await callProcessWebhook({
      stripe: makeStripe(event1),
      config,
      updateSubscription: updateSubscription1,
    });
    await callProcessWebhook({
      stripe: makeStripe(event2),
      config,
      updateSubscription: updateSubscription2,
    });

    expect(updateSubscription1).toHaveBeenCalledTimes(1);
    expect(updateSubscription2).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------

describe('processWebhook — config validation', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls validateStripeBackConfig with the supplied billing config', async () => {
    const { validateStripeBackConfig } = await import('@donotdev/core/server');
    const config = makeConfig();
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_cfg', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_cfg',
      customer: 'cus_cfg',
    });
    const stripe = makeStripe(event);

    await callProcessWebhook({ stripe, config });

    expect(validateStripeBackConfig).toHaveBeenCalledWith(config);
  });

  it('routes with the original config so hooks survive validation (valibot strips unknown keys)', async () => {
    const { validateStripeBackConfig } = await import('@donotdev/core/server');
    // Mimic valibot output: functions (hooks) are dropped from the parse result
    (validateStripeBackConfig as any).mockImplementationOnce((c: unknown) =>
      JSON.parse(JSON.stringify(c))
    );
    const onSubscriptionCreated = vi.fn(async () => {});
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_strip', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_strip',
      customer: 'cus_strip',
    });

    await callProcessWebhook({
      stripe: makeStripe(event),
      config: makeConfig({ onSubscriptionCreated }),
    });

    expect(onSubscriptionCreated).toHaveBeenCalledOnce();
  });

  it('throws when validateStripeBackConfig throws', async () => {
    const { validateStripeBackConfig } = await import('@donotdev/core/server');
    (validateStripeBackConfig as any).mockImplementationOnce(() => {
      throw new Error('Invalid billing config');
    });

    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_bad', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_bad',
      customer: 'cus_bad',
    });

    await expect(
      callProcessWebhook({ stripe: makeStripe(event) })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('event routing — checkout.session.completed (StripeSubscription)', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls updateSubscription with active status and subscription fields', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_sub', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_123',
      customer: 'cus_123',
    });
    const config = makeConfig();
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription,
    });

    expect(updateSubscription).toHaveBeenCalledOnce();
    const [userId, data] = (updateSubscription as any).mock.calls[0];
    expect(userId).toBe('u_sub');
    expect(data.tier).toBe('pro');
    expect(data.status).toBe('active');
    expect(data.subscriptionId).toBe('sub_123');
    expect(data.customerId).toBe('cus_123');
    expect(typeof data.subscriptionEnd).toBe('string');
  });

  it('calls onSubscriptionCreated hook on success', async () => {
    const onSubscriptionCreated = vi.fn(async () => {});
    const config = makeConfig({ onSubscriptionCreated });
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_hook', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_hook',
      customer: 'cus_hook',
    });

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription: makeUpdateSubscription(),
    });

    expect(onSubscriptionCreated).toHaveBeenCalledWith(
      'u_hook',
      expect.any(Object)
    );
  });

  it('does NOT throw when onSubscriptionCreated hook throws (non-critical)', async () => {
    const onSubscriptionCreated = vi.fn(async () => {
      throw new Error('hook exploded');
    });
    const config = makeConfig({ onSubscriptionCreated });
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_hook_fail', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_hf',
      customer: 'cus_hf',
    });

    await expect(
      callProcessWebhook({
        stripe: makeStripe(event),
        config,
        updateSubscription: makeUpdateSubscription(),
      })
    ).resolves.toEqual({ success: true, message: 'Webhook processed' });
  });

  it('throws when metadata is missing userId', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { billingConfigKey: 'pro_monthly' },
      subscription: 'sub_no_user',
      customer: 'cus_no_user',
    });

    await expect(
      callProcessWebhook({ stripe: makeStripe(event) })
    ).rejects.toThrow();
  });

  it('throws when metadata is missing billingConfigKey', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_no_key' },
      subscription: 'sub_no_key',
      customer: 'cus_no_key',
    });

    await expect(
      callProcessWebhook({ stripe: makeStripe(event) })
    ).rejects.toThrow();
  });

  it('throws when billingConfigKey does not match any config entry', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_unknown', billingConfigKey: 'nonexistent_plan' },
      subscription: 'sub_unknown',
      customer: 'cus_unknown',
    });

    await expect(
      callProcessWebhook({ stripe: makeStripe(event) })
    ).rejects.toThrow();
  });

  it('throws when authProvider is null (subscription update requires auth)', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_no_auth', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_no_auth',
      customer: 'cus_no_auth',
    });

    await expect(
      callProcessWebhook({ stripe: makeStripe(event), authProvider: null })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('event routing — checkout.session.completed (StripePayment)', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls updateSubscription with active status and customerId (no subscriptionId)', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_pay', billingConfigKey: 'lifetime_purchase' },
      subscription: null,
      customer: 'cus_pay',
    });
    const config = makeConfig();
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription,
    });

    expect(updateSubscription).toHaveBeenCalledOnce();
    const [userId, data] = (updateSubscription as any).mock.calls[0];
    expect(userId).toBe('u_pay');
    expect(data.tier).toBe('premium');
    expect(data.status).toBe('active');
    expect(data.customerId).toBe('cus_pay');
    // StripePayment does not pass subscriptionId
    expect(data.subscriptionId).toBeUndefined();
  });

  it('calls onPurchaseSuccess hook on success', async () => {
    const onPurchaseSuccess = vi.fn(async () => {});
    const config = {
      ...makeConfig(),
      lifetime_purchase: {
        ...makeConfig().lifetime_purchase,
        onPurchaseSuccess,
      },
    };
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_pay_hook', billingConfigKey: 'lifetime_purchase' },
      subscription: null,
      customer: 'cus_pay_hook',
    });

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription: makeUpdateSubscription(),
    });

    expect(onPurchaseSuccess).toHaveBeenCalledWith(
      'u_pay_hook',
      expect.any(Object)
    );
  });

  it('does NOT throw when onPurchaseSuccess hook throws (non-critical)', async () => {
    const onPurchaseSuccess = vi.fn(async () => {
      throw new Error('purchase hook failed');
    });
    const config = {
      ...makeConfig(),
      lifetime_purchase: {
        ...makeConfig().lifetime_purchase,
        onPurchaseSuccess,
      },
    };
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_phf', billingConfigKey: 'lifetime_purchase' },
      subscription: null,
      customer: 'cus_phf',
    });

    await expect(
      callProcessWebhook({
        stripe: makeStripe(event),
        config,
        updateSubscription: makeUpdateSubscription(),
      })
    ).resolves.toEqual({ success: true, message: 'Webhook processed' });
  });
});

// ---------------------------------------------------------------------------

describe('event routing — invoice.payment_succeeded', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('retrieves subscription and renews it with active status', async () => {
    const invoice = {
      id: 'in_renewal',
      subscription: 'sub_renewal',
      customer: 'cus_renewal',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_renewal',
      metadata: { userId: 'u_renewal', billingConfigKey: 'pro_monthly' },
    }));

    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, updateSubscription });

    expect(stripe.subscriptions.retrieve).toHaveBeenCalledWith('sub_renewal');
    expect(updateSubscription).toHaveBeenCalledOnce();
    const [userId, data] = (updateSubscription as any).mock.calls[0];
    expect(userId).toBe('u_renewal');
    expect(data.status).toBe('active');
    expect(data.subscriptionId).toBe('sub_renewal');
    expect(data.customerId).toBe('cus_renewal');
  });

  it('calls onSubscriptionRenewed hook on successful renewal', async () => {
    const onSubscriptionRenewed = vi.fn(async () => {});
    const config = makeConfig({ onSubscriptionRenewed });

    const invoice = {
      id: 'in_hook_renewal',
      subscription: 'sub_hook_renewal',
      customer: 'cus_hook_renewal',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_hook_renewal',
      metadata: { userId: 'u_hook_renewal', billingConfigKey: 'pro_monthly' },
    }));

    await callProcessWebhook({
      stripe,
      config,
      updateSubscription: makeUpdateSubscription(),
    });

    expect(onSubscriptionRenewed).toHaveBeenCalledWith(
      'u_hook_renewal',
      expect.any(Object)
    );
  });

  it('does NOT throw when onSubscriptionRenewed hook throws (non-critical)', async () => {
    const onSubscriptionRenewed = vi.fn(async () => {
      throw new Error('renewal hook failed');
    });
    const config = makeConfig({ onSubscriptionRenewed });

    const invoice = {
      id: 'in_hook_fail',
      subscription: 'sub_hook_fail',
      customer: 'cus_hook_fail',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_hook_fail',
      metadata: { userId: 'u_hook_fail', billingConfigKey: 'pro_monthly' },
    }));

    await expect(
      callProcessWebhook({
        stripe,
        config,
        updateSubscription: makeUpdateSubscription(),
      })
    ).resolves.toEqual({ success: true, message: 'Webhook processed' });
  });

  it('returns success without calling updateSubscription when invoice has no subscriptionId', async () => {
    const invoice = {
      id: 'in_no_sub',
      subscription: null,
      customer: 'cus_no_sub',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, updateSubscription });

    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('returns success without calling updateSubscription when subscription metadata is missing userId', async () => {
    const invoice = {
      id: 'in_no_metadata',
      subscription: 'sub_no_meta',
      customer: 'cus_no_meta',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_no_meta',
      metadata: {},
    }));
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, updateSubscription });

    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('returns success without updating when billingItem type is StripePayment (not renewable)', async () => {
    const config = {
      lifetime_purchase: makeConfig().lifetime_purchase,
    };
    const invoice = {
      id: 'in_payment_type',
      subscription: 'sub_payment_type',
      customer: 'cus_payment_type',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_payment_type',
      metadata: {
        userId: 'u_payment_type',
        billingConfigKey: 'lifetime_purchase',
      },
    }));
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, config, updateSubscription });

    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('throws when authProvider is null during renewal', async () => {
    const invoice = {
      id: 'in_no_auth',
      subscription: 'sub_no_auth',
      customer: 'cus_no_auth',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_no_auth',
      metadata: { userId: 'u_no_auth', billingConfigKey: 'pro_monthly' },
    }));

    await expect(
      callProcessWebhook({ stripe, authProvider: null })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('event routing — customer.subscription.deleted', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls updateSubscription with CANCELED status and FREE tier', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const subscription = {
      id: 'sub_del',
      customer: 'cus_del',
      metadata: { userId: 'u_del', billingConfigKey: 'pro_monthly' },
      current_period_end: periodEnd,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe: makeStripe(event), updateSubscription });

    expect(updateSubscription).toHaveBeenCalledOnce();
    const [userId, data] = (updateSubscription as any).mock.calls[0];
    expect(userId).toBe('u_del');
    expect(data.status).toBe('canceled');
    expect(data.tier).toBe('free');
    expect(data.subscriptionId).toBe('sub_del');
    expect(data.customerId).toBe('cus_del');
    // subscriptionEnd is derived from current_period_end timestamp
    expect(typeof data.subscriptionEnd).toBe('string');
  });

  it('calls onSubscriptionCancelled hook on successful cancellation', async () => {
    const onSubscriptionCancelled = vi.fn(async () => {});
    const config = makeConfig({ onSubscriptionCancelled });

    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const subscription = {
      id: 'sub_cancel_hook',
      customer: 'cus_cancel_hook',
      metadata: { userId: 'u_cancel_hook', billingConfigKey: 'pro_monthly' },
      current_period_end: periodEnd,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription: makeUpdateSubscription(),
    });

    expect(onSubscriptionCancelled).toHaveBeenCalledWith(
      'u_cancel_hook',
      expect.any(Object)
    );
  });

  it('does NOT throw when onSubscriptionCancelled hook throws (non-critical)', async () => {
    const onSubscriptionCancelled = vi.fn(async () => {
      throw new Error('cancel hook failed');
    });
    const config = makeConfig({ onSubscriptionCancelled });

    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const subscription = {
      id: 'sub_cancel_hf',
      customer: 'cus_cancel_hf',
      metadata: { userId: 'u_cancel_hf', billingConfigKey: 'pro_monthly' },
      current_period_end: periodEnd,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);

    await expect(
      callProcessWebhook({
        stripe: makeStripe(event),
        config,
        updateSubscription: makeUpdateSubscription(),
      })
    ).resolves.toEqual({ success: true, message: 'Webhook processed' });
  });

  it('returns success without calling updateSubscription when metadata is missing', async () => {
    const subscription = {
      id: 'sub_no_meta_del',
      customer: 'cus_no_meta_del',
      metadata: {},
      current_period_end: Date.now() / 1000,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe: makeStripe(event), updateSubscription });

    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('returns success without updating when billingItem type is StripePayment (not cancellable)', async () => {
    const config = {
      lifetime_purchase: makeConfig().lifetime_purchase,
    };
    const subscription = {
      id: 'sub_pay_del',
      customer: 'cus_pay_del',
      metadata: { userId: 'u_pay_del', billingConfigKey: 'lifetime_purchase' },
      current_period_end: Date.now() / 1000,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription,
    });

    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('throws when authProvider is null during cancellation', async () => {
    const subscription = {
      id: 'sub_no_auth_del',
      customer: 'cus_no_auth_del',
      metadata: { userId: 'u_no_auth_del', billingConfigKey: 'pro_monthly' },
      current_period_end: Date.now() / 1000,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);

    await expect(
      callProcessWebhook({ stripe: makeStripe(event), authProvider: null })
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------

describe('event routing — invoice.payment_failed', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('calls onPurchaseFailure for StripePayment billing items', async () => {
    const onPurchaseFailure = vi.fn(async () => {});
    const config = {
      ...makeConfig(),
      lifetime_purchase: {
        ...makeConfig().lifetime_purchase,
        onPurchaseFailure,
      },
    };
    const invoice = {
      id: 'in_fail_pay',
      customer: 'cus_fail_pay',
      metadata: { userId: 'u_fail_pay', billingConfigKey: 'lifetime_purchase' },
    };
    const event = makeEvent('invoice.payment_failed', invoice);

    await callProcessWebhook({ stripe: makeStripe(event), config });

    expect(onPurchaseFailure).toHaveBeenCalledWith(
      'u_fail_pay',
      expect.any(Object)
    );
  });

  it('calls onPaymentFailed for StripeSubscription billing items', async () => {
    const onPaymentFailed = vi.fn(async () => {});
    const config = makeConfig({ onPaymentFailed });
    const invoice = {
      id: 'in_fail_sub',
      customer: 'cus_fail_sub',
      metadata: { userId: 'u_fail_sub', billingConfigKey: 'pro_monthly' },
    };
    const event = makeEvent('invoice.payment_failed', invoice);

    await callProcessWebhook({ stripe: makeStripe(event), config });

    expect(onPaymentFailed).toHaveBeenCalledWith(
      'u_fail_sub',
      expect.any(Object)
    );
  });

  it('does NOT throw when onPurchaseFailure hook throws (non-critical)', async () => {
    const onPurchaseFailure = vi.fn(async () => {
      throw new Error('failure hook exploded');
    });
    const config = {
      ...makeConfig(),
      lifetime_purchase: {
        ...makeConfig().lifetime_purchase,
        onPurchaseFailure,
      },
    };
    const invoice = {
      id: 'in_hf_pay',
      customer: 'cus_hf_pay',
      metadata: { userId: 'u_hf_pay', billingConfigKey: 'lifetime_purchase' },
    };
    const event = makeEvent('invoice.payment_failed', invoice);

    await expect(
      callProcessWebhook({ stripe: makeStripe(event), config })
    ).resolves.toEqual({ success: true, message: 'Webhook processed' });
  });

  it('does NOT throw when onPaymentFailed hook throws (non-critical)', async () => {
    const onPaymentFailed = vi.fn(async () => {
      throw new Error('payment failed hook exploded');
    });
    const config = makeConfig({ onPaymentFailed });
    const invoice = {
      id: 'in_hf_sub',
      customer: 'cus_hf_sub',
      metadata: { userId: 'u_hf_sub', billingConfigKey: 'pro_monthly' },
    };
    const event = makeEvent('invoice.payment_failed', invoice);

    await expect(
      callProcessWebhook({ stripe: makeStripe(event), config })
    ).resolves.toEqual({ success: true, message: 'Webhook processed' });
  });

  it('returns success without calling hooks when invoice metadata is missing', async () => {
    const onPaymentFailed = vi.fn(async () => {});
    const config = makeConfig({ onPaymentFailed });
    const invoice = {
      id: 'in_no_meta_fail',
      customer: 'cus_no_meta_fail',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_failed', invoice);

    await callProcessWebhook({ stripe: makeStripe(event), config });

    expect(onPaymentFailed).not.toHaveBeenCalled();
  });

  it('returns success without calling hooks when billingConfigKey is unknown', async () => {
    const onPaymentFailed = vi.fn(async () => {});
    const config = makeConfig({ onPaymentFailed });
    const invoice = {
      id: 'in_bad_key_fail',
      customer: 'cus_bad_key_fail',
      metadata: { userId: 'u_bad_key', billingConfigKey: 'does_not_exist' },
    };
    const event = makeEvent('invoice.payment_failed', invoice);

    await callProcessWebhook({ stripe: makeStripe(event), config });

    expect(onPaymentFailed).not.toHaveBeenCalled();
  });

  it('does not call updateSubscription (payment_failed is notification-only)', async () => {
    const config = makeConfig();
    const invoice = {
      id: 'in_no_update',
      customer: 'cus_no_update',
      metadata: { userId: 'u_no_update', billingConfigKey: 'pro_monthly' },
    };
    const event = makeEvent('invoice.payment_failed', invoice);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({
      stripe: makeStripe(event),
      config,
      updateSubscription,
    });

    expect(updateSubscription).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('event routing — unknown event types', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('handles unknown event type gracefully — returns success without throwing', async () => {
    const event = makeEvent('customer.updated', { id: 'cus_unknown_type' });
    const updateSubscription = makeUpdateSubscription();

    const result = await callProcessWebhook({
      stripe: makeStripe(event),
      updateSubscription,
    });

    expect(result).toEqual({ success: true, message: 'Webhook processed' });
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('handles payment_intent.succeeded gracefully (not in router)', async () => {
    const event = makeEvent('payment_intent.succeeded', {
      id: 'pi_not_routed',
    });

    const result = await callProcessWebhook({ stripe: makeStripe(event) });

    expect(result).toEqual({ success: true, message: 'Webhook processed' });
  });

  it('handles customer.subscription.updated gracefully (not in router)', async () => {
    const event = makeEvent('customer.subscription.updated', {
      id: 'sub_updated',
      metadata: {},
    });

    const result = await callProcessWebhook({ stripe: makeStripe(event) });

    expect(result).toEqual({ success: true, message: 'Webhook processed' });
  });
});

// ---------------------------------------------------------------------------

describe('state machine transitions', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('checkout.session.completed → status=active (StripeSubscription)', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_sm_active', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_sm_active',
      customer: 'cus_sm_active',
    });
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe: makeStripe(event), updateSubscription });

    const [, data] = (updateSubscription as any).mock.calls[0];
    expect(data.status).toBe('active');
  });

  it('checkout.session.completed → status=active (StripePayment)', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: {
        userId: 'u_sm_pay_active',
        billingConfigKey: 'lifetime_purchase',
      },
      subscription: null,
      customer: 'cus_sm_pay_active',
    });
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe: makeStripe(event), updateSubscription });

    const [, data] = (updateSubscription as any).mock.calls[0];
    expect(data.status).toBe('active');
    expect(data.tier).toBe('premium');
  });

  it('invoice.payment_succeeded → status=active (renewal)', async () => {
    const invoice = {
      id: 'in_sm_renewal',
      subscription: 'sub_sm_renewal',
      customer: 'cus_sm_renewal',
      metadata: {},
    };
    const event = makeEvent('invoice.payment_succeeded', invoice);
    const stripe = makeStripe(event);
    stripe.subscriptions.retrieve = vi.fn(async () => ({
      id: 'sub_sm_renewal',
      metadata: { userId: 'u_sm_renewal', billingConfigKey: 'pro_monthly' },
    }));
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, updateSubscription });

    const [, data] = (updateSubscription as any).mock.calls[0];
    expect(data.status).toBe('active');
    expect(data.tier).toBe('pro');
  });

  it('customer.subscription.deleted → status=canceled, tier=free (downgrade)', async () => {
    const periodEnd = Math.floor(Date.now() / 1000) + 86400;
    const subscription = {
      id: 'sub_sm_del',
      customer: 'cus_sm_del',
      metadata: { userId: 'u_sm_del', billingConfigKey: 'pro_monthly' },
      current_period_end: periodEnd,
    };
    const event = makeEvent('customer.subscription.deleted', subscription);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe: makeStripe(event), updateSubscription });

    const [, data] = (updateSubscription as any).mock.calls[0];
    expect(data.status).toBe('canceled');
    expect(data.tier).toBe('free');
    // subscriptionEnd set to current_period_end
    const expectedEnd = new Date(periodEnd * 1000).toISOString();
    expect(data.subscriptionEnd).toBe(expectedEnd);
  });
});

// ---------------------------------------------------------------------------

describe('processWebhook — return value', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns { success: true, message: "Webhook processed" } on success', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_ret', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_ret',
      customer: 'cus_ret',
    });

    const result = await callProcessWebhook({ stripe: makeStripe(event) });

    expect(result).toEqual({ success: true, message: 'Webhook processed' });
  });

  it('returns { success: true, message: "Event already processed" } for duplicate event', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_dup2', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_dup2',
      customer: 'cus_dup2',
    });

    await callProcessWebhook({ stripe: makeStripe(event) });
    const result = await callProcessWebhook({ stripe: makeStripe(event) });

    expect(result).toEqual({
      success: true,
      message: 'Event already processed',
    });
  });
});

// ---------------------------------------------------------------------------

describe('processWebhook — idempotency lifecycle', () => {
  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('releases the reservation when routing throws, so the retry is processed', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_retry', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_retry',
      customer: 'cus_retry',
    });
    const failing = vi.fn(async () => {
      throw new Error('claims write failed');
    });

    await expect(
      callProcessWebhook({ stripe: makeStripe(event), updateSubscription: failing })
    ).rejects.toThrow();

    const updateSubscription = makeUpdateSubscription();
    const result = await callProcessWebhook({
      stripe: makeStripe(event),
      updateSubscription,
    });
    expect(result.message).toBe('Webhook processed');
    expect(updateSubscription).toHaveBeenCalledOnce();
  });

  it('marks the event processed only after success, with the owner token', async () => {
    const markProcessed = vi.fn(async () => {});
    idempotencyStore = {
      reserve: vi.fn(async () => ({ state: 'reserved' as const, ownerToken: 'tok_1' })),
      markProcessed,
      release: vi.fn(async () => true),
    };
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_mark', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_mark',
      customer: 'cus_mark',
    });

    await callProcessWebhook({ stripe: makeStripe(event) });
    expect(markProcessed).toHaveBeenCalledWith(event.id, 'tok_1');
  });
});

// ---------------------------------------------------------------------------

describe('event routing — StripeOrder', () => {
  const PAID_LINES = [
    {
      id: 'li_1',
      description: 'Serum 30ml',
      quantity: 24,
      amount_subtotal: 24000,
      amount_discount: 0,
      amount_tax: 4800,
      amount_total: 28800,
      price: {
        product: { id: 'prod_1', deleted: undefined, metadata: { productId: 'serum-30ml' } },
      },
    },
  ];

  function makeOrderConfig(hooks: Record<string, any> = {}) {
    return {
      ...makeConfig(),
      shop_order: {
        type: 'StripeOrder' as const,
        name: 'Shop order',
        currency: 'eur',
        tax: { mode: 'manual' as const, taxRateIds: ['txr_fr_20'] },
        taxIdCollection: 'optional' as const,
        billingAddressCollection: 'required' as const,
        customerCreation: 'always' as const,
        invoiceCreation: true,
        resolveLineItems: vi.fn(),
        onOrderPaid: vi.fn(async () => {}),
        ...hooks,
      },
    };
  }

  function makeOrderSession(overrides: Record<string, any> = {}) {
    return {
      id: 'cs_order_1',
      payment_status: 'paid',
      currency: 'eur',
      amount_subtotal: 24000,
      amount_total: 28800,
      total_details: { amount_discount: 0, amount_shipping: 0, amount_tax: 4800 },
      customer: 'cus_order',
      customer_details: {
        email: 'buyer@pro.example',
        name: 'Buyer',
        phone: null,
        business_name: 'Pro SARL',
        individual_name: null,
        address: { line1: '1 rue A', line2: null, postal_code: '75001', city: 'Paris', state: null, country: 'FR' },
        tax_exempt: 'none',
        tax_ids: [{ type: 'eu_vat', value: 'FR00123456789' }],
      },
      collected_information: null,
      invoice: 'in_order',
      payment_intent: 'pi_order',
      metadata: { userId: 'u_order', billingConfigKey: 'shop_order', orderId: 'ord_42' },
      ...overrides,
    };
  }

  function makeOrderStripe(event: any) {
    const stripe = makeStripe(event);
    stripe.checkout = {
      sessions: {
        listLineItems: vi.fn(() => ({
          async *[Symbol.asyncIterator]() {
            yield* PAID_LINES;
          },
        })),
      },
    };
    return stripe;
  }

  beforeEach(() => {
    resetIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('completed + paid → onOrderPaid with snapshot, paid lines and context; no subscription update', async () => {
    const config = makeOrderConfig();
    const event = makeEvent('checkout.session.completed', makeOrderSession());
    const stripe = makeOrderStripe(event);
    const updateSubscription = makeUpdateSubscription();

    await callProcessWebhook({ stripe, config, updateSubscription });

    expect(stripe.checkout.sessions.listLineItems).toHaveBeenCalledWith(
      'cs_order_1',
      { limit: 100, expand: ['data.price.product'] }
    );
    const onOrderPaid = config.shop_order.onOrderPaid;
    expect(onOrderPaid).toHaveBeenCalledOnce();
    const [snapshot, lines, ctx] = (onOrderPaid as any).mock.calls[0];
    expect(snapshot).toMatchObject({
      id: 'cs_order_1',
      paymentStatus: 'paid',
      amountTax: 4800,
      invoiceId: 'in_order',
      customer: {
        businessName: 'Pro SARL',
        taxIds: [{ type: 'eu_vat', value: 'FR00123456789' }],
        address: { postalCode: '75001', country: 'FR' },
      },
    });
    expect(lines).toEqual([
      {
        productId: 'serum-30ml',
        name: 'Serum 30ml',
        quantity: 24,
        amountSubtotal: 24000,
        amountDiscount: 0,
        amountTax: 4800,
        amountTotal: 28800,
      },
    ]);
    expect(ctx).toEqual({
      userId: 'u_order',
      orderId: 'ord_42',
      billingConfigKey: 'shop_order',
      eventId: event.id,
    });
    expect(updateSubscription).not.toHaveBeenCalled();
  });

  it('completed + unpaid (SEPA) → waits, onOrderPaid not called', async () => {
    const config = makeOrderConfig();
    const event = makeEvent(
      'checkout.session.completed',
      makeOrderSession({ payment_status: 'unpaid' })
    );

    await callProcessWebhook({ stripe: makeOrderStripe(event), config });

    expect(config.shop_order.onOrderPaid).not.toHaveBeenCalled();
  });

  it('async_payment_succeeded → onOrderPaid', async () => {
    const config = makeOrderConfig();
    const event = makeEvent(
      'checkout.session.async_payment_succeeded',
      makeOrderSession()
    );

    await callProcessWebhook({ stripe: makeOrderStripe(event), config });

    expect(config.shop_order.onOrderPaid).toHaveBeenCalledOnce();
  });

  it('async_payment_failed → onOrderPaymentFailed', async () => {
    const onOrderPaymentFailed = vi.fn(async () => {});
    const config = makeOrderConfig({ onOrderPaymentFailed });
    const event = makeEvent(
      'checkout.session.async_payment_failed',
      makeOrderSession({ payment_status: 'unpaid' })
    );

    await callProcessWebhook({ stripe: makeOrderStripe(event), config });

    expect(onOrderPaymentFailed).toHaveBeenCalledOnce();
    expect(config.shop_order.onOrderPaid).not.toHaveBeenCalled();
  });

  it('expired → onOrderExpired', async () => {
    const onOrderExpired = vi.fn(async () => {});
    const config = makeOrderConfig({ onOrderExpired });
    const event = makeEvent(
      'checkout.session.expired',
      makeOrderSession({ payment_status: 'unpaid' })
    );

    await callProcessWebhook({ stripe: makeOrderStripe(event), config });

    expect(onOrderExpired).toHaveBeenCalledOnce();
  });

  it('onOrderPaid failure rejects (Stripe retries) and the retry is processed once', async () => {
    const onOrderPaid = vi
      .fn()
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce(undefined);
    const config = makeOrderConfig({ onOrderPaid });
    const event = makeEvent('checkout.session.completed', makeOrderSession());

    await expect(
      callProcessWebhook({ stripe: makeOrderStripe(event), config })
    ).rejects.toThrow();
    await callProcessWebhook({ stripe: makeOrderStripe(event), config });
    const third = await callProcessWebhook({
      stripe: makeOrderStripe(event),
      config,
    });

    expect(onOrderPaid).toHaveBeenCalledTimes(2);
    expect(third.message).toBe('Event already processed');
  });

  it('rejects order events rendered with an API version older than collected_information', async () => {
    const config = makeOrderConfig();
    const event = makeEvent('checkout.session.completed', makeOrderSession());
    event.api_version = '2024-12-18.acacia';

    await expect(
      callProcessWebhook({ stripe: makeOrderStripe(event), config })
    ).rejects.toThrow();
    expect(config.shop_order.onOrderPaid).not.toHaveBeenCalled();
  });

  it('throws when the order session has no orderId', async () => {
    const config = makeOrderConfig();
    const event = makeEvent(
      'checkout.session.completed',
      makeOrderSession({ metadata: { userId: 'u_order', billingConfigKey: 'shop_order' } })
    );

    await expect(
      callProcessWebhook({ stripe: makeOrderStripe(event), config })
    ).rejects.toThrow();
    expect(config.shop_order.onOrderPaid).not.toHaveBeenCalled();
  });

  it('throws when a paid line carries no productId metadata', async () => {
    const config = makeOrderConfig();
    const event = makeEvent('checkout.session.completed', makeOrderSession());
    const stripe = makeOrderStripe(event);
    stripe.checkout.sessions.listLineItems = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {
        yield { ...PAID_LINES[0], price: { product: { id: 'prod_x', metadata: {} } } };
      },
    }));

    await expect(callProcessWebhook({ stripe, config })).rejects.toThrow();
    expect(config.shop_order.onOrderPaid).not.toHaveBeenCalled();
  });

  it('ignores async/expired events for non-order items', async () => {
    const updateSubscription = makeUpdateSubscription();
    const event = makeEvent('checkout.session.expired', {
      id: 'cs_sub',
      metadata: { userId: 'u_sub', billingConfigKey: 'pro_monthly' },
    });

    const result = await callProcessWebhook({
      stripe: makeStripe(event),
      updateSubscription,
    });

    expect(result.message).toBe('Webhook processed');
    expect(updateSubscription).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------

describe('processWebhook — 0.1.x call without a store', () => {
  beforeEach(() => {
    resetLegacyIdempotencyStore();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('falls back to the deprecated auto-detected store and still deduplicates', async () => {
    const event = makeEvent('checkout.session.completed', {
      metadata: { userId: 'u_legacy', billingConfigKey: 'pro_monthly' },
      subscription: 'sub_legacy',
      customer: 'cus_legacy',
    });
    const updateSubscription = makeUpdateSubscription();
    const call = () =>
      processWebhook(
        RAW_BODY,
        SIGNATURE,
        WEBHOOK_SECRET,
        makeStripe(event),
        makeConfig(),
        updateSubscription,
        makeAuthProvider()
      );

    await call();
    const second = await call();
    expect(second.message).toBe('Event already processed');
    expect(updateSubscription).toHaveBeenCalledOnce();
  });
});
