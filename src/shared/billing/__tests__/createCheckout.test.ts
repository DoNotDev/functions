// packages/functions/src/shared/billing/__tests__/createCheckout.test.ts

/**
 * @fileoverview Tests for createCheckoutAlgorithm
 * @description Unit tests using dependency injection — no real Stripe or Firebase calls.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import type {
  CreateCheckoutSessionRequest,
  StripeBackConfig,
} from '@donotdev/core/server';

import { createCheckoutAlgorithm } from '../createCheckout.js';

import type {
  StripeCheckoutProvider,
  AuthCheckoutProvider,
} from '../createCheckout.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_PRICE_ID = 'price_test_abc123';

const BILLING_CONFIG: StripeBackConfig = {
  pro_monthly: {
    type: 'StripeSubscription',
    name: 'Pro Monthly',
    price: 1999,
    currency: 'EUR',
    priceId: VALID_PRICE_ID,
    tier: 'pro',
    duration: '1month',
  },
  starter_once: {
    type: 'StripePayment',
    name: 'Starter Pack',
    price: 4900,
    currency: 'EUR',
    priceId: 'price_starter_xyz',
    tier: 'starter',
    duration: 'lifetime',
  },
};

const BASE_REQUEST: CreateCheckoutSessionRequest = {
  userId: 'user_001',
  priceId: VALID_PRICE_ID,
  successUrl: 'https://app.example.com/billing/success',
  cancelUrl: 'https://app.example.com/billing/cancel',
  metadata: { billingConfigKey: 'pro_monthly' },
  mode: 'subscription',
};

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeStripeProvider(
  overrides?: Partial<StripeCheckoutProvider>
): StripeCheckoutProvider {
  return {
    createCheckoutSession: vi.fn().mockResolvedValue({
      id: 'cs_test_session123',
      url: 'https://checkout.stripe.com/pay/cs_test_session123',
    }),
    ...overrides,
  };
}

function makeAuthProvider(
  overrides?: Partial<AuthCheckoutProvider>
): AuthCheckoutProvider {
  return {
    getUser: vi.fn().mockResolvedValue({ customClaims: {} }),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createCheckoutAlgorithm', () => {
  let stripeProvider: StripeCheckoutProvider;
  let authProvider: AuthCheckoutProvider;

  beforeEach(() => {
    stripeProvider = makeStripeProvider();
    authProvider = makeAuthProvider();
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('valid checkout creation', () => {
    it('returns sessionId and sessionUrl on success', async () => {
      const result = await createCheckoutAlgorithm(
        BASE_REQUEST,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(result).toEqual({
        sessionId: 'cs_test_session123',
        sessionUrl: 'https://checkout.stripe.com/pay/cs_test_session123',
      });
    });

    it('verifies the user before creating the session', async () => {
      await createCheckoutAlgorithm(
        BASE_REQUEST,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(authProvider.getUser).toHaveBeenCalledOnce();
      expect(authProvider.getUser).toHaveBeenCalledWith('user_001');
    });

    it('forwards priceId, mode, successUrl, cancelUrl to Stripe', async () => {
      await createCheckoutAlgorithm(
        BASE_REQUEST,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(stripeProvider.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          priceId: VALID_PRICE_ID,
          mode: 'subscription',
          successUrl: 'https://app.example.com/billing/success',
          cancelUrl: 'https://app.example.com/billing/cancel',
        })
      );
    });

    it('ensures userId and billingConfigKey are set in session metadata', async () => {
      await createCheckoutAlgorithm(
        BASE_REQUEST,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(stripeProvider.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            userId: 'user_001',
            billingConfigKey: 'pro_monthly',
          }),
        })
      );
    });

    it('passes customerEmail through when provided', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        customerEmail: 'user@example.com',
      };

      await createCheckoutAlgorithm(
        request,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(stripeProvider.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ customerEmail: 'user@example.com' })
      );
    });

    it('defaults allowPromotionCodes to true when not provided', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        allowPromotionCodes: undefined,
      };

      await createCheckoutAlgorithm(
        request,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(stripeProvider.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ allowPromotionCodes: true })
      );
    });

    it('defaults mode to "payment" when not provided', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        mode: undefined,
      };

      await createCheckoutAlgorithm(
        request,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(stripeProvider.createCheckoutSession).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'payment' })
      );
    });

    it('handles null sessionUrl from Stripe', async () => {
      stripeProvider = makeStripeProvider({
        createCheckoutSession: vi.fn().mockResolvedValue({
          id: 'cs_test_no_url',
          url: null,
        }),
      });

      const result = await createCheckoutAlgorithm(
        BASE_REQUEST,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(result.sessionUrl).toBeNull();
      expect(result.sessionId).toBe('cs_test_no_url');
    });

    it('works with a different valid billing config key', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        priceId: 'price_starter_xyz',
        metadata: { billingConfigKey: 'starter_once' },
        mode: 'payment',
      };

      const result = await createCheckoutAlgorithm(
        request,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(result.sessionId).toBe('cs_test_session123');
    });
  });

  // -------------------------------------------------------------------------
  // Missing / invalid params
  // -------------------------------------------------------------------------

  describe('missing required params', () => {
    it('throws when billingConfigKey is absent from metadata', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        metadata: {},
      };

      await expect(
        createCheckoutAlgorithm(
          request,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Missing billingConfigKey in metadata');
    });

    it('throws when metadata itself is undefined', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        metadata: undefined,
      };

      await expect(
        createCheckoutAlgorithm(
          request,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Missing billingConfigKey in metadata');
    });

    it('does not call Stripe when billingConfigKey is missing', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        metadata: {},
      };

      await expect(
        createCheckoutAlgorithm(
          request,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow();

      expect(stripeProvider.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Invalid plan / price
  // -------------------------------------------------------------------------

  describe('invalid plan / price', () => {
    it('throws when billingConfigKey does not exist in config', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        metadata: { billingConfigKey: 'nonexistent_plan' },
      };

      await expect(
        createCheckoutAlgorithm(
          request,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Invalid billing config key: nonexistent_plan');
    });

    it('throws when priceId does not match the config entry', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        priceId: 'price_wrong_one',
        metadata: { billingConfigKey: 'pro_monthly' },
      };

      await expect(
        createCheckoutAlgorithm(
          request,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Price ID mismatch with configuration');
    });

    it('does not call Stripe when priceId mismatches config', async () => {
      const request: CreateCheckoutSessionRequest = {
        ...BASE_REQUEST,
        priceId: 'price_totally_different',
        metadata: { billingConfigKey: 'pro_monthly' },
      };

      await expect(
        createCheckoutAlgorithm(
          request,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow();

      expect(stripeProvider.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Auth validation
  // -------------------------------------------------------------------------

  describe('auth validation', () => {
    it('calls getUser with the request userId', async () => {
      await createCheckoutAlgorithm(
        BASE_REQUEST,
        stripeProvider,
        authProvider,
        BILLING_CONFIG
      );

      expect(authProvider.getUser).toHaveBeenCalledWith('user_001');
    });

    it('propagates error when getUser rejects', async () => {
      authProvider = makeAuthProvider({
        getUser: vi.fn().mockRejectedValue(new Error('User not found')),
      });

      await expect(
        createCheckoutAlgorithm(
          BASE_REQUEST,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('User not found');
    });

    it('does not call Stripe when auth fails', async () => {
      authProvider = makeAuthProvider({
        getUser: vi.fn().mockRejectedValue(new Error('Unauthenticated')),
      });

      await expect(
        createCheckoutAlgorithm(
          BASE_REQUEST,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow();

      expect(stripeProvider.createCheckoutSession).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Stripe error handling
  // -------------------------------------------------------------------------

  describe('Stripe error handling', () => {
    it('propagates Stripe API errors', async () => {
      stripeProvider = makeStripeProvider({
        createCheckoutSession: vi
          .fn()
          .mockRejectedValue(new Error('Stripe network error')),
      });

      await expect(
        createCheckoutAlgorithm(
          BASE_REQUEST,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Stripe network error');
    });

    it('propagates Stripe card declined errors', async () => {
      stripeProvider = makeStripeProvider({
        createCheckoutSession: vi
          .fn()
          .mockRejectedValue(new Error('Your card was declined')),
      });

      await expect(
        createCheckoutAlgorithm(
          BASE_REQUEST,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Your card was declined');
    });

    it('propagates Stripe rate limit errors', async () => {
      stripeProvider = makeStripeProvider({
        createCheckoutSession: vi
          .fn()
          .mockRejectedValue(new Error('Too many requests to the Stripe API')),
      });

      await expect(
        createCheckoutAlgorithm(
          BASE_REQUEST,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toThrow('Too many requests');
    });

    it('does not swallow unknown errors from Stripe', async () => {
      const unexpected = new Error('Unexpected internal Stripe error');

      stripeProvider = makeStripeProvider({
        createCheckoutSession: vi.fn().mockRejectedValue(unexpected),
      });

      await expect(
        createCheckoutAlgorithm(
          BASE_REQUEST,
          stripeProvider,
          authProvider,
          BILLING_CONFIG
        )
      ).rejects.toBe(unexpected);
    });
  });
});
