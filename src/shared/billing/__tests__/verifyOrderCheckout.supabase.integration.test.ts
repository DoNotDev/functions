import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import { VerifyOrderCheckoutRequestSchema } from '@donotdev/core/server';
import type { StripeOrderBackItem } from '@donotdev/core/server';

import { createSupabaseHandler } from '../../../supabase/baseFunction.js';
import { logger } from '../../logger.js';
import { verifyOrderCheckoutAlgorithm } from '../verifyOrderCheckout.js';
import type { VerifyOrderCheckoutDependencies } from '../verifyOrderCheckout.js';

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async (token: string) => ({
      data: { user: token === 'valid' ? { id: 'owner', app_metadata: {} } : null },
      error: null,
    }) },
  }),
}));
vi.mock('../../logger.js', () => ({ logger: { warn: vi.fn() } }));

const request = { sessionId: 'cs_private', billingConfigKey: 'shop' };
const binding = { ...request, userId: 'owner', orderId: 'order_private' };

function fixture() {
  const order: StripeOrderBackItem = {
    type: 'StripeOrder', name: 'Shop', currency: 'eur',
    tax: { mode: 'automatic' }, taxIdCollection: 'disabled',
    billingAddressCollection: 'auto', customerCreation: 'if_required', invoiceCreation: false,
    resolveLineItems: vi.fn(), beforeCheckout: vi.fn(), onOrderPaid: vi.fn(),
    onOrderExpired: vi.fn(), onOrderPaymentFailed: vi.fn(), onTaxIdUpdated: vi.fn(),
  };
  const deps = {
    billingConfig: { shop: order },
    resolveOrderBinding: vi.fn<VerifyOrderCheckoutDependencies['resolveOrderBinding']>(async () => binding),
    retrieveStripeSession: vi.fn<VerifyOrderCheckoutDependencies['retrieveStripeSession']>(async () => ({
      id: request.sessionId, mode: 'payment', status: 'complete', payment_status: 'paid',
      metadata: { userId: 'owner', billingConfigKey: 'shop', orderId: binding.orderId },
    })),
  };
  const handler = createSupabaseHandler('verify-order-checkout', v.unknown(), (input, ctx) =>
    verifyOrderCheckoutAlgorithm(input, { ...deps, userId: ctx.uid })
  );
  return { deps, handler, order };
}

function post(body: string, token = 'valid') {
  return new Request('https://example.test/verify', {
    method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body,
  });
}

beforeEach(() => {
  vi.stubEnv('SUPABASE_URL', 'https://example.test');
  vi.stubEnv('SUPABASE_SECRET_KEY', 'synthetic');
  vi.stubEnv('DISABLE_RATE_LIMITING', 'true');
  vi.stubEnv('ENABLE_METRICS', 'false');
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(logger.warn).mockReset();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('checkout verification through the real Supabase handler', () => {
  it('returns only verified state using the authenticated identity without invoking fulfillment', async () => {
    const { handler, deps, order } = fixture();
    const response = await handler(post(JSON.stringify({ ...request, userId: 'attacker' })));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ...request, orderId: binding.orderId, sessionStatus: 'complete', paymentStatus: 'paid' });
    expect(deps.resolveOrderBinding).toHaveBeenCalledExactlyOnceWith({ ...request, userId: 'owner' });
    expect(order.onOrderPaid).not.toHaveBeenCalled();
    expect(order.beforeCheckout).not.toHaveBeenCalled();
  });

  it.each(['malformed', 'foreign', 'missing', 'mismatch', 'provider'] as const)(
    'maps %s to the same safe response', async (scenario) => {
      const { handler, deps } = fixture();
      if (scenario === 'foreign') deps.resolveOrderBinding.mockResolvedValue({ ...binding, userId: 'foreign_secret' });
      if (scenario === 'missing') deps.resolveOrderBinding.mockResolvedValue(null);
      if (scenario === 'mismatch') deps.resolveOrderBinding.mockResolvedValue({ ...binding, sessionId: 'cs_other_secret' });
      if (scenario === 'provider') deps.retrieveStripeSession.mockRejectedValue(new Error('sk_secret private@example.com'));
      const input = scenario === 'malformed' ? { sessionId: '', billingConfigKey: 'shop' } : request;
      const response = await handler(post(JSON.stringify(input)));
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: 'Checkout verification denied' });
      if (scenario === 'malformed') expect(deps.resolveOrderBinding).not.toHaveBeenCalled();
      if (scenario !== 'provider') expect(deps.retrieveStripeSession).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledExactlyOnceWith('[Checkout verification] Failed', {
        stage: scenario === 'malformed' ? 'validation' : scenario === 'provider' ? 'provider' : 'binding',
        category: scenario === 'malformed' ? 'invalid' : scenario === 'provider' ? 'unavailable' : 'rejected',
      });
    }
  );

  it('demonstrates direct schema validation differs, while auth and parsing retain base-handler behavior', async () => {
    const { handler } = fixture();
    const strict = createSupabaseHandler('strict-example', VerifyOrderCheckoutRequestSchema, async () => ({}));
    const invalid = await strict(post(JSON.stringify({ sessionId: '' })));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).error).toMatch(/^Validation failed:/);
    const unauthorized = await handler(post('{}', 'invalid'));
    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({ error: 'Invalid or expired token' });
    const badJson = await handler(post('{'));
    expect(badJson.status).toBe(403);
    expect(await badJson.json()).toEqual({ error: 'Checkout verification denied' });
  });
});
