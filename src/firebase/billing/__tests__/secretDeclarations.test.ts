// packages/functions/src/firebase/billing/__tests__/secretDeclarations.test.ts

/**
 * @fileoverview Billing functions declare the Stripe secrets they read
 * @description The deploy binds a secret to a function only when the function
 * declares it (`secrets` option → `__endpoint.secretEnvironmentVariables`).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@donotdev/firebase/server', () => ({
  getFirebaseAdminAuth: vi.fn(),
  getFirebaseAdminFirestore: vi.fn(),
  FieldValue: {},
}));

import { billingHealth } from '../healthCheck';
import { cancelSubscription } from '../cancelSubscription';
import { changePlan } from '../changePlan';
import { createCheckoutSession } from '../createCheckoutSession';
import { createCustomerPortal } from '../createCustomerPortal';
import { refreshSubscriptionStatus } from '../refreshSubscriptionStatus';
import { createStripeWebhook } from '../webhookHandler';

/** Secret names a built function declares. */
function declared(fn: {
  __endpoint: { secretEnvironmentVariables?: Array<{ key: string }> };
}): string[] {
  return (fn.__endpoint.secretEnvironmentVariables ?? []).map((s) => s.key);
}

describe('billing functions declare their Stripe secrets', () => {
  it.each([
    ['createCheckoutSession', () => createCheckoutSession({})],
    ['createCustomerPortal', () => createCustomerPortal()],
    ['cancelSubscription', () => cancelSubscription()],
    ['changePlan', () => changePlan({})],
    ['refreshSubscriptionStatus', () => refreshSubscriptionStatus()],
  ])('%s declares STRIPE_SECRET_KEY', (_name, create) => {
    expect(declared(create())).toEqual(['STRIPE_SECRET_KEY']);
  });

  it.each([
    ['createStripeWebhook', () => createStripeWebhook({})],
    ['billingHealth', () => billingHealth],
  ])(
    '%s declares STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET',
    (_name, create) => {
      expect(declared(create())).toEqual([
        'STRIPE_SECRET_KEY',
        'STRIPE_WEBHOOK_SECRET',
      ]);
    }
  );
});
