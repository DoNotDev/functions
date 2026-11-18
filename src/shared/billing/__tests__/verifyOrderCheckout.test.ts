import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { StripeOrderBackItem } from '@donotdev/core/server';

import { logger } from '../../logger.js';
import { verifyOrderCheckoutAlgorithm } from '../verifyOrderCheckout.js';
import type {
  OrderCheckoutBinding,
  VerifyOrderCheckoutDependencies,
} from '../verifyOrderCheckout.js';

vi.mock('../../logger.js', () => ({ logger: { warn: vi.fn() } }));

beforeEach(() => {
  vi.mocked(logger.warn).mockReset();
});

const request = { sessionId: 'cs_owner', billingConfigKey: 'shop' };
const binding: OrderCheckoutBinding = {
  ...request, userId: 'owner', orderId: 'order_1',
};
type Session = Awaited<ReturnType<VerifyOrderCheckoutDependencies['retrieveStripeSession']>>;

function fixture() {
  const session: Session = {
    id: request.sessionId, mode: 'payment', status: 'complete', payment_status: 'paid',
    metadata: { userId: 'owner', billingConfigKey: 'shop', orderId: 'order_1', secret: 'private' },
  };
  const order: StripeOrderBackItem = {
    type: 'StripeOrder', name: 'Shop', currency: 'eur',
    tax: { mode: 'automatic' }, taxIdCollection: 'disabled',
    billingAddressCollection: 'auto', customerCreation: 'if_required', invoiceCreation: false,
    resolveLineItems: vi.fn(), beforeCheckout: vi.fn(), onOrderPaid: vi.fn(),
    onOrderExpired: vi.fn(), onOrderPaymentFailed: vi.fn(), onTaxIdUpdated: vi.fn(),
  };
  const deps = {
    userId: 'owner', billingConfig: { shop: order },
    retrieveStripeSession: vi.fn<VerifyOrderCheckoutDependencies['retrieveStripeSession']>(async () => session),
    resolveOrderBinding: vi.fn<VerifyOrderCheckoutDependencies['resolveOrderBinding']>(async () => ({ ...binding })),
  };
  return { session, order, deps };
}

async function denied(deps: VerifyOrderCheckoutDependencies, input = request) {
  await expect(verifyOrderCheckoutAlgorithm(input, deps)).rejects.toEqual(
    new Error('Checkout verification denied')
  );
}

describe('verifyOrderCheckoutAlgorithm', () => {
  it('verifies the authenticated owner, uses read dependencies, and returns only allowlisted state', async () => {
    const { deps, session } = fixture();
    Object.assign(session, { customer_details: { email: 'private@example.com' }, customer: 'cus_secret' });
    const result = await verifyOrderCheckoutAlgorithm({ ...request, ...{ userId: 'attacker' } }, deps);
    expect(result).toEqual({
      ...request, orderId: 'order_1', sessionStatus: 'complete', paymentStatus: 'paid',
    });
    expect(deps.resolveOrderBinding).toHaveBeenCalledExactlyOnceWith({ ...request, userId: 'owner' });
    expect(deps.retrieveStripeSession).toHaveBeenCalledExactlyOnceWith('cs_owner');
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it.each([
    ['complete', 'paid'], ['complete', 'unpaid'], ['complete', 'no_payment_required'],
    ['open', 'unpaid'], ['expired', 'unpaid'],
  ] as const)('represents %s/%s without asserting fulfillment or invoking hooks', async (status, paymentStatus) => {
    const { deps, session, order } = fixture();
    session.status = status;
    session.payment_status = paymentStatus;
    const writes = vi.fn();
    Object.assign(deps, { writeOrder: writes, clearCart: writes, fulfillOrder: writes });
    const original = JSON.stringify({ session, order });
    await expect(verifyOrderCheckoutAlgorithm(request, deps)).resolves.toEqual({
      ...request, orderId: 'order_1', sessionStatus: status, paymentStatus,
    });
    for (const hook of [order.resolveLineItems, order.beforeCheckout, order.onOrderPaid,
      order.onOrderExpired, order.onOrderPaymentFailed, order.onTaxIdUpdated]) {
      expect(hook).not.toHaveBeenCalled();
    }
    expect(writes).not.toHaveBeenCalled();
    expect(JSON.stringify({ session, order })).toBe(original);
  });

  it.each(['orderId', 'userId', 'sessionId', 'billingConfigKey'] as const)(
    'rejects a mismatched persisted binding %s with the same public error', async (key) => {
      const { deps } = fixture();
      deps.resolveOrderBinding.mockResolvedValue({ ...binding, [key]: 'foreign' });
      await denied(deps);
    }
  );

  it.each([null, undefined])('fails closed without persisted binding (%s), even with valid Stripe metadata', async (value) => {
    const { deps } = fixture();
    deps.resolveOrderBinding.mockResolvedValue(value);
    await denied(deps);
    expect(deps.retrieveStripeSession).not.toHaveBeenCalled();
  });

  it.each(['', '   '])('rejects empty persisted order IDs (%j)', async (orderId) => {
    const { deps } = fixture();
    deps.resolveOrderBinding.mockResolvedValue({ ...binding, orderId });
    await denied(deps);
  });

  it.each(['userId', 'billingConfigKey', 'orderId'] as const)('requires matching server metadata %s', async (key) => {
    for (const value of [undefined, '', 'foreign']) {
      const { deps, session } = fixture();
      session.metadata = { userId: 'owner', billingConfigKey: 'shop', orderId: 'order_1' };
      if (value === undefined) delete session.metadata[key];
      else session.metadata[key] = value;
      await denied(deps);
    }
  });

  it('rejects absent metadata and foreign authenticated owners', async () => {
    const { deps, session } = fixture();
    session.metadata = null;
    await denied(deps);
    const foreign = fixture();
    foreign.deps.userId = 'attacker';
    await denied(foreign.deps);
  });

  it.each(['subscription', 'setup'] as const)('rejects mode %s', async (mode) => {
    const { deps, session } = fixture();
    session.mode = mode;
    await denied(deps);
  });

  it('rejects a retrieved session ID mismatch', async () => {
    const { deps, session } = fixture();
    session.id = 'cs_other';
    await denied(deps);
  });

  it.each([null, undefined, 'unknown'])('rejects invalid session status %s', async (status) => {
    const { deps, session } = fixture();
    Object.assign(session, { status });
    await denied(deps);
  });

  it.each([null, undefined, 'unknown'])('rejects invalid payment status %s', async (payment_status) => {
    const { deps, session } = fixture();
    Object.assign(session, { payment_status });
    await denied(deps);
  });

  it('rejects missing/wrong server configs before reading dependencies', async () => {
    const { deps } = fixture();
    await denied(deps, { ...request, billingConfigKey: 'missing' });
    await denied(deps, { ...request, billingConfigKey: '__proto__' });
    for (const type of ['StripePayment', 'StripeSubscription']) {
      Object.assign(deps.billingConfig.shop, { type });
      await denied(deps);
    }
    expect(deps.resolveOrderBinding).not.toHaveBeenCalled();
    expect(deps.retrieveStripeSession).not.toHaveBeenCalled();
  });

  it('validates input and authenticated identity even when invoked without a schema handler', async () => {
    const { deps } = fixture();
    await denied(deps, { ...request, sessionId: '' });
    await denied(deps, { ...request, billingConfigKey: ' ' });
    deps.userId = '';
    await denied(deps);
    expect(deps.resolveOrderBinding).not.toHaveBeenCalled();
  });

  it.each([
    ['retrieveStripeSession', 'provider'],
    ['resolveOrderBinding', 'binding'],
  ] as const)('diagnoses unavailable %s without leaking dependency errors', async (key, stage) => {
    const { deps } = fixture();
    deps[key].mockRejectedValue(new Error(
      'owner order_1 cs_owner sk_test_secret Cookie: session=private private@example.com'
    ));
    await denied(deps);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      '[Checkout verification] Failed', { stage, category: 'unavailable' }
    );
  });

  it('distinguishes rejected owner from unavailable storage without logging identities', async () => {
    const { deps } = fixture();
    deps.resolveOrderBinding.mockResolvedValue({ ...binding, userId: 'foreign_owner_secret' });
    await denied(deps);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      '[Checkout verification] Failed', { stage: 'binding', category: 'rejected' }
    );
    expect(deps.retrieveStripeSession).not.toHaveBeenCalled();
  });

  it.each(['validation', 'auth', 'config', 'response'] as const)(
    'records sanitized %s diagnostics', async (stage) => {
      const { deps, session } = fixture();
      let input = request;
      if (stage === 'validation') input = { ...request, sessionId: '' };
      if (stage === 'auth') deps.userId = '';
      if (stage === 'config') deps.billingConfig = {};
      if (stage === 'response') Object.assign(session, { status: 'secret_invalid_status' });
      await denied(deps, input);
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
        '[Checkout verification] Failed',
        { stage, category: stage === 'auth' ? 'rejected' : 'invalid' }
      );
    }
  );

  it('diagnoses rejected provider metadata without logging provider/customer data', async () => {
    const { deps, session } = fixture();
    session.metadata = { userId: 'foreign_owner_secret', token: 'sk_test_secret' };
    Object.assign(session, { customer_details: { email: 'private@example.com' } });
    await denied(deps);
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      '[Checkout verification] Failed', { stage: 'response', category: 'rejected' }
    );
  });

  it.each(['throw', 'reject'] as const)('preserves safe public error when logger fails (%s)', async (mode) => {
    const { deps } = fixture();
    deps.retrieveStripeSession.mockRejectedValue(new Error('provider credential secret'));
    vi.mocked(logger.warn).mockImplementation(() => {
      if (mode === 'throw') throw new Error('logger credential secret');
      return Promise.reject(new Error('logger credential secret'));
    });
    const error = await verifyOrderCheckoutAlgorithm(request, deps).catch((cause: unknown) => cause);
    expect(error).toEqual(new Error('Checkout verification denied'));
    expect(error).not.toHaveProperty('cause');
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      '[Checkout verification] Failed', { stage: 'provider', category: 'unavailable' }
    );
  });
});
