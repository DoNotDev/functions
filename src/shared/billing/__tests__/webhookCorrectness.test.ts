// packages/functions/src/shared/billing/__tests__/webhookCorrectness.test.ts

/**
 * @fileoverview Webhook delivery correctness
 * @description Three-state reservation (processed / in_progress / reserved),
 * owner token, bounded markProcessed retry, payment_status matrix for tier
 * items, and the order API version error.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/detectFirestore.js', () => ({
  isFirestoreConfigured: vi.fn(() => false),
}));

vi.mock('@donotdev/core/server', () => ({
  validateStripeBackConfig: vi.fn((config: unknown) => config),
  SUBSCRIPTION_STATUS: { ACTIVE: 'active', CANCELED: 'canceled' },
  SUBSCRIPTION_TIERS: { FREE: 'free' },
  calculateSubscriptionEndDate: vi.fn(() => '2026-03-18T00:00:00.000Z'),
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
}));

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminFirestore: vi.fn(),
}));

vi.mock('../../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { logger } from '../../logger.js';
import {
  ReservationLostError,
  createInMemoryIdempotencyStore,
} from '../idempotency.js';
import type { IdempotencyStore } from '../idempotency.js';
import { processWebhook } from '../webhookHandler.js';

const config = {
  pro_monthly: {
    type: 'StripeSubscription' as const,
    name: 'Pro',
    price: 999,
    currency: 'usd',
    priceId: 'price_pro',
    tier: 'pro',
    duration: '1month',
    onSubscriptionCreated: vi.fn(async () => {}),
  },
  lifetime: {
    type: 'StripePayment' as const,
    name: 'Lifetime',
    price: 19900,
    currency: 'usd',
    priceId: 'price_life',
    tier: 'premium',
    duration: 'lifetime',
    onPurchaseSuccess: vi.fn(async () => {}),
  },
  shop_order: {
    type: 'StripeOrder' as const,
    name: 'Shop',
    currency: 'eur',
    resolveLineItems: vi.fn(),
    onOrderPaid: vi.fn(async () => {}),
  },
};

let counter = 0;
function makeEvent(type: string, session: Record<string, unknown>): any {
  counter += 1;
  return {
    id: `evt_corr_${counter}`,
    type,
    api_version: '2025-02-24.acacia',
    data: { object: { id: `cs_${counter}`, customer: 'cus_1', ...session } },
  };
}

function stripeFor(event: any): any {
  return {
    webhooks: { constructEventAsync: vi.fn(async () => event) },
    subscriptions: { retrieve: vi.fn() },
  };
}

const authProvider = {
  getUser: vi.fn(async () => ({ customClaims: {} })),
  setCustomUserClaims: vi.fn(async () => {}),
};

function run(
  event: any,
  store: IdempotencyStore,
  updateSubscription = vi.fn(async () => {})
) {
  return processWebhook(
    'raw',
    'sig',
    'whsec',
    stripeFor(event),
    config as any,
    updateSubscription,
    authProvider,
    store
  );
}

/** Store double recording calls, reserving with a fixed token. */
function makeStore(overrides: Partial<IdempotencyStore> = {}) {
  return {
    reserve: vi.fn(async () => ({
      state: 'reserved' as const,
      ownerToken: 'tok_a',
    })),
    markProcessed: vi.fn(async () => {}),
    release: vi.fn(async () => true),
    ...overrides,
  };
}

const tierSession = (key: 'pro_monthly' | 'lifetime', paymentStatus: string) => ({
  payment_status: paymentStatus,
  subscription: key === 'pro_monthly' ? 'sub_1' : null,
  metadata: { userId: 'u1', billingConfigKey: key },
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reservation states', () => {
  it('processed → 2xx skip, nothing routed', async () => {
    const store = makeStore({ reserve: vi.fn(async () => ({ state: 'processed' as const })) });
    const update = vi.fn(async () => {});
    const result = await run(
      makeEvent('checkout.session.completed', tierSession('lifetime', 'paid')),
      store,
      update
    );
    expect(result).toEqual({ success: true, message: 'Event already processed' });
    expect(update).not.toHaveBeenCalled();
    expect(store.markProcessed).not.toHaveBeenCalled();
  });

  it('in_progress → rejects with unavailable (non-2xx), nothing routed, released or marked', async () => {
    const store = makeStore({ reserve: vi.fn(async () => ({ state: 'in_progress' as const })) });
    const update = vi.fn(async () => {});
    const event = makeEvent('checkout.session.completed', tierSession('lifetime', 'paid'));

    await expect(run(event, store, update)).rejects.toMatchObject({
      code: 'unavailable',
      details: { eventId: event.id, reason: 'webhook_event_in_progress' },
    });
    expect(update).not.toHaveBeenCalled();
    expect(store.release).not.toHaveBeenCalled();
    expect(store.markProcessed).not.toHaveBeenCalled();
  });

  it('a second delivery during a live lease is answered non-2xx, then 2xx once processed', async () => {
    const store = createInMemoryIdempotencyStore();
    const event = makeEvent('checkout.session.completed', tierSession('lifetime', 'paid'));
    let release!: () => void;
    const slow = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve))
    );

    const first = run(event, store, slow);
    for (let i = 0; i < 50 && slow.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    expect(slow).toHaveBeenCalled();
    await expect(run(event, store)).rejects.toMatchObject({ code: 'unavailable' });
    release();
    await expect(first).resolves.toEqual({ success: true, message: 'Webhook processed' });
    await expect(run(event, store)).resolves.toEqual({
      success: true,
      message: 'Event already processed',
    });
  });

  it('routing failure releases with the owner token and rethrows', async () => {
    const store = makeStore();
    const failing = vi.fn(async () => {
      throw new Error('claims write failed');
    });
    await expect(
      run(makeEvent('checkout.session.completed', tierSession('lifetime', 'paid')), store, failing)
    ).rejects.toThrow();
    expect(store.release).toHaveBeenCalledWith(expect.any(String), 'tok_a');
    expect(store.markProcessed).not.toHaveBeenCalled();
  });

  it('a stale release (not owner) is logged, the routing error still propagates', async () => {
    const store = makeStore({ release: vi.fn(async () => false) });
    await expect(
      run(
        makeEvent('checkout.session.completed', tierSession('lifetime', 'paid')),
        store,
        vi.fn(async () => {
          throw new Error('boom');
        })
      )
    ).rejects.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      '[Webhook] Reservation not released: no longer owned',
      expect.objectContaining({ operation: 'idempotency_release_stale' })
    );
  });
});

describe('markProcessed after a successful hook', () => {
  it('retries transient failures and succeeds', async () => {
    const markProcessed = vi
      .fn()
      .mockRejectedValueOnce(new Error('firestore unavailable'))
      .mockRejectedValueOnce(new Error('firestore unavailable'))
      .mockResolvedValueOnce(undefined);
    const store = makeStore({ markProcessed });
    const result = await run(
      makeEvent('checkout.session.completed', tierSession('lifetime', 'paid')),
      store
    );
    expect(result.message).toBe('Webhook processed');
    expect(markProcessed).toHaveBeenCalledTimes(3);
    expect(markProcessed).toHaveBeenCalledWith(expect.any(String), 'tok_a');
    expect(store.release).not.toHaveBeenCalled();
  });

  it('after 3 failed attempts rejects (non-2xx) WITHOUT releasing; hook ran once', async () => {
    const markProcessed = vi.fn(async () => {
      throw new Error('postgrest 503');
    });
    const store = makeStore({ markProcessed });
    const update = vi.fn(async () => {});
    await expect(
      run(makeEvent('checkout.session.completed', tierSession('lifetime', 'paid')), store, update)
    ).rejects.toThrow();
    expect(markProcessed).toHaveBeenCalledTimes(3);
    expect(store.release).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledOnce();
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Event processed but not recorded'),
      expect.objectContaining({ attempts: 3 })
    );
  });

  it('does not retry a lost reservation', async () => {
    const markProcessed = vi.fn(async (eventId: string) => {
      throw new ReservationLostError(eventId);
    });
    const store = makeStore({ markProcessed });
    await expect(
      run(makeEvent('checkout.session.completed', tierSession('lifetime', 'paid')), store)
    ).rejects.toThrow();
    expect(markProcessed).toHaveBeenCalledTimes(1);
    expect(store.release).not.toHaveBeenCalled();
  });

  it('the redelivery after the lease grants again with the same data (idempotent grant)', async () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(realNow);
    try {
      const store = createInMemoryIdempotencyStore();
      const realMark = store.markProcessed;
      store.markProcessed = vi.fn(async () => {
        throw new Error('down');
      });
      const update = vi.fn(async () => {});
      const event = makeEvent('checkout.session.completed', tierSession('pro_monthly', 'paid'));

      await expect(run(event, store, update)).rejects.toThrow();
      await expect(run(event, store, update)).rejects.toMatchObject({ code: 'unavailable' });

      store.markProcessed = realMark;
      now.mockReturnValue(realNow + 70 * 60 * 1000 + 1);
      await expect(run(event, store, update)).resolves.toEqual({
        success: true,
        message: 'Webhook processed',
      });
      expect(update).toHaveBeenCalledTimes(2);
      expect((update.mock.calls as any[])[0].slice(0, 2)).toEqual(
        (update.mock.calls as any[])[1].slice(0, 2)
      );
    } finally {
      now.mockRestore();
    }
  });
});

describe('tier items: payment_status matrix', () => {
  const cases: Array<[string, string, boolean]> = [
    ['checkout.session.completed', 'paid', true],
    ['checkout.session.completed', 'no_payment_required', true],
    ['checkout.session.completed', 'unpaid', false],
    ['checkout.session.async_payment_succeeded', 'paid', true],
    ['checkout.session.async_payment_failed', 'unpaid', false],
    ['checkout.session.expired', 'unpaid', false],
  ];

  for (const key of ['lifetime', 'pro_monthly'] as const) {
    for (const [type, status, grants] of cases) {
      it(`${key}: ${type} + ${status} → ${grants ? 'grant' : 'no grant'}`, async () => {
        const update = vi.fn(async () => {});
        const result = await run(makeEvent(type, tierSession(key, status)), makeStore(), update);
        expect(result.message).toBe('Webhook processed');
        expect(update).toHaveBeenCalledTimes(grants ? 1 : 0);
        const hook =
          key === 'lifetime'
            ? config.lifetime.onPurchaseSuccess
            : config.pro_monthly.onSubscriptionCreated;
        expect(hook).toHaveBeenCalledTimes(grants ? 1 : 0);
        if (grants) {
          expect((update.mock.calls as any[])[0][1]).toMatchObject({ status: 'active' });
        }
      });
    }
  }

  it('unpaid completion is logged as pending; async failure is logged as failed', async () => {
    await run(makeEvent('checkout.session.completed', tierSession('lifetime', 'unpaid')), makeStore());
    expect(logger.info).toHaveBeenCalledWith(
      '[Webhook] Purchase awaiting async payment',
      expect.objectContaining({ operation: 'purchase_payment_pending' })
    );
    await run(
      makeEvent('checkout.session.async_payment_failed', tierSession('lifetime', 'unpaid')),
      makeStore()
    );
    expect(logger.warn).toHaveBeenCalledWith(
      '[Webhook] Async purchase payment failed, nothing granted',
      expect.objectContaining({ operation: 'purchase_payment_failed' })
    );
  });

  it('unknown payment_status fails loud and releases the reservation', async () => {
    const store = makeStore();
    const update = vi.fn(async () => {});
    await expect(
      run(makeEvent('checkout.session.completed', tierSession('lifetime', 'mystery')), store, update)
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledOnce();
  });
});

describe('StripeOrder API version error', () => {
  it('names the webhook endpoint version as the cause and logs the actionable message', async () => {
    const event = makeEvent('checkout.session.completed', {
      payment_status: 'paid',
      metadata: { userId: 'u1', billingConfigKey: 'shop_order', orderId: 'ord_1' },
    });
    event.api_version = '2024-12-18.acacia';
    const store = makeStore();

    await expect(run(event, store)).rejects.toThrow();
    expect(config.shop_order.onOrderPaid).not.toHaveBeenCalled();
    expect(store.release).toHaveBeenCalledOnce();
    const logged = (logger.error as any).mock.calls.find(
      ([message]: [string]) => message === '[Webhook] Event processing failed, releasing reservation'
    );
    const text: string = logged[1].error.message;
    expect(text).toContain('2024-12-18.acacia');
    expect(text).toContain('2025-02-24.acacia');
    expect(text).toContain("webhook endpoint's API version");
    expect(text).toContain('not STRIPE_API_VERSION');
    expect(text).toContain('api_version=2025-02-24.acacia');
  });
});
