import { afterEach, describe, expect, it, vi } from 'vitest';
import * as v from 'valibot';

import type { SubscriptionUpdate } from '@donotdev/core/server';
import { SubscriptionClaimsSchema } from '../../../../../core/types/src/auth/schemas';
import { updateUserSubscription } from '../helpers/updateUserSubscription';

// Keep the real canonical schema while isolating unrelated server integrations.
vi.mock('@donotdev/core/server', async () => {
  const { SubscriptionClaimsSchema } = await import('../../../../../core/types/src/auth/schemas');
  return { SubscriptionClaimsSchema };
});

function paidUpdate(): SubscriptionUpdate {
  return {
    tier: 'pro',
    status: 'active',
    subscriptionEnd: '2026-07-01T00:00:00.000Z',
    subscriptionId: 'sub_paid',
    customerId: 'cus_paid',
    cancelAtPeriodEnd: false,
  };
}

function provider() {
  const customClaims = {
    role: 'admin',
    permissions: ['manage-team'],
    unrelated: { preserved: true },
    subscription: { tier: 'old', features: ['old-feature'] },
  };
  return {
    customClaims,
    getUser: vi.fn(async () => ({ customClaims })),
    setCustomUserClaims: vi.fn(async (_userId: string, _claims: Record<string, unknown>) => {}),
  };
}

describe('updateUserSubscription', () => {
  afterEach(() => vi.useRealTimers());

  it.each(['active', 'canceled', 'past_due', 'trialing', 'incomplete'] as const)(
    'writes canonical paid %s claims and preserves unrelated metadata',
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-06-02T12:34:56.789Z'));
      const auth = provider();
      const update = { ...paidUpdate(), status };
      await updateUserSubscription('user-a', update, auth);
      const subscription = {
        ...update,
        updatedAt: new Date().toISOString(),
        isDefault: false,
      };
      expect(v.parse(SubscriptionClaimsSchema, subscription)).toEqual(subscription);
      expect(auth.setCustomUserClaims).toHaveBeenCalledExactlyOnceWith('user-a', {
        ...auth.customClaims,
        subscription,
      });
      expect(auth.customClaims.subscription).toEqual({ tier: 'old', features: ['old-feature'] });
    }
  );

  it.each([
    { tier: 'member', status: 'active' },
    { tier: 'free', status: 'canceled' },
  ] as const)('writes complete $tier access without payment identifiers', async ({ tier, status }) => {
    const auth = provider();
    await updateUserSubscription('user-a', { tier, status, subscriptionEnd: null }, auth);
    expect(auth.setCustomUserClaims).toHaveBeenCalledExactlyOnceWith('user-a', {
      ...auth.customClaims,
      subscription: {
        tier,
        status,
        subscriptionEnd: null,
        subscriptionId: null,
        customerId: null,
        cancelAtPeriodEnd: false,
        updatedAt: expect.any(String),
        isDefault: false,
      },
    });
    const claims = auth.setCustomUserClaims.mock.calls[0]?.[1];
    expect(v.safeParse(SubscriptionClaimsSchema, claims?.subscription).success).toBe(true);
  });

  it('supports one-time paid access without a recurring subscription ID', async () => {
    const auth = provider();
    const update = paidUpdate();
    delete update.subscriptionId;
    delete update.cancelAtPeriodEnd;
    update.subscriptionEnd = null;
    await updateUserSubscription('user-a', update, auth);
    expect(auth.setCustomUserClaims).toHaveBeenCalledWith('user-a', expect.objectContaining({
      subscription: expect.objectContaining({
        customerId: 'cus_paid', subscriptionId: null, subscriptionEnd: null,
        cancelAtPeriodEnd: false,
      }),
    }));
  });

  it.each(['tier', 'status'] as const)('retains the missing %s error', async (field) => {
    const auth = provider();
    const update = paidUpdate();
    Reflect.set(update, field, '');
    await expect(updateUserSubscription('user-a', update, auth))
      .rejects.toThrow('Invalid subscription data: missing tier or status');
    expect(auth.setCustomUserClaims).not.toHaveBeenCalled();
  });

  it.each([undefined, null])('preserves customer-less one-time checkout without fabricating an ID: %s', async (customerId) => {
    const auth = provider();
    const update = paidUpdate();
    delete update.subscriptionId;
    Reflect.set(update, 'customerId', customerId);
    await updateUserSubscription('user-a', update, auth);
    expect(auth.setCustomUserClaims).toHaveBeenCalledWith('user-a', expect.objectContaining({
      subscription: expect.objectContaining({ customerId: null, subscriptionId: null }),
    }));
  });

  it.each([
    ['tier', 42],
    ['status', true],
    ['subscriptionEnd', 'not-a-timestamp'],
    ['subscriptionEnd', undefined],
    ['subscriptionId', { id: 'sub_expanded' }],
    ['customerId', { id: 'cus_expanded' }],
    ['cancelAtPeriodEnd', 'false'],
  ])('rejects invalid %s before persisting claims', async (field, value) => {
    const auth = provider();
    const update = paidUpdate();
    // Exercise untrusted runtime input without changing the typed producer API.
    Reflect.set(update, field, value);
    await expect(updateUserSubscription('user-a', update, auth)).rejects.toThrow();
    expect(auth.setCustomUserClaims).not.toHaveBeenCalled();
    expect(auth.customClaims.unrelated).toEqual({ preserved: true });
  });
});
