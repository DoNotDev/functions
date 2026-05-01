// packages/functions/src/shared/billing/createCheckout.ts

/**
 * @fileoverview Create Checkout Session Algorithm
 * @description Platform-agnostic algorithm for creating Stripe checkout sessions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionResponse,
  StripeBackConfig,
} from '@donotdev/core/server';

/**
 * Provider interface for Stripe checkout operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface StripeCheckoutProvider {
  createCheckoutSession(params: {
    priceId?: string;
    /** Amount in cents (dynamic pricing mode) */
    unitAmount?: number;
    /** Product name for Stripe checkout (dynamic pricing mode) */
    productName?: string;
    /** Currency code, defaults to 'eur' */
    currency?: string;
    customerEmail?: string;
    metadata: Record<string, string>;
    allowPromotionCodes: boolean;
    successUrl: string;
    cancelUrl: string;
    mode?: 'payment' | 'subscription';
  }): Promise<{
    id: string;
    url: string | null;
  }>;
}

/**
 * Provider interface for authentication operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface AuthCheckoutProvider {
  getUser(userId: string): Promise<{
    customClaims?: Record<string, any>;
  }>;
}

/**
 * Validate URL has http/https protocol.
 * Platform-agnostic (no firebase logger dependency).
 */
function validateCheckoutUrl(url: string, name: string): void {
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      throw new Error(`Invalid protocol: ${parsed.protocol}`);
    }
  } catch (error) {
    throw new Error(
      `Invalid ${name} URL: ${url}. ${error instanceof Error ? error.message : 'Invalid URL format'}`
    );
  }
}

/**
 * Sanitize metadata: enforce string values, strip script injection, cap lengths.
 * Platform-agnostic (no firebase logger dependency).
 */
function sanitizeMetadata(
  metadata: Record<string, any>
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new Error(
        `Metadata value for key '${key}' must be a string, got ${typeof value}`
      );
    }

    const sanitizedValue = value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '');

    if (sanitizedValue.length > 1000) {
      throw new Error(
        `Metadata value for key '${key}' is too long (max 1000 characters)`
      );
    }

    if (key.length > 100) {
      throw new Error(`Metadata key '${key}' is too long (max 100 characters)`);
    }

    sanitized[key] = sanitizedValue;
  }

  return sanitized;
}

/**
 * Create checkout session algorithm
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function createCheckoutAlgorithm(
  request: CreateCheckoutSessionRequest,
  stripeProvider: StripeCheckoutProvider,
  authProvider: AuthCheckoutProvider,
  billingConfig: StripeBackConfig
): Promise<CreateCheckoutSessionResponse> {
  if (!process.env.FRONTEND_URL) {
    throw new Error('FRONTEND_URL environment variable is required');
  }

  const {
    priceId,
    unitAmount,
    productName,
    currency,
    userId,
    customerEmail,
    metadata = {},
    allowPromotionCodes = true,
    successUrl,
    cancelUrl,
    mode = 'payment',
  } = request;

  // ✅ VALIDATE: billingConfigKey exists
  const configKey = metadata.billingConfigKey;
  if (!configKey) {
    throw new Error('Missing billingConfigKey in metadata');
  }

  // ✅ VALIDATE: config key is valid
  const billingItem = billingConfig[configKey];
  if (!billingItem) {
    throw new Error(`Invalid billing config key: ${configKey}`);
  }

  // ✅ VALIDATE: either priceId or (unitAmount + productName)
  const useDynamicPricing = !priceId && unitAmount && productName;
  if (!priceId && !useDynamicPricing) {
    throw new Error('Either priceId or (unitAmount + productName) is required');
  }

  // ✅ VALIDATE: price_data not supported for subscriptions
  if (useDynamicPricing && mode === 'subscription') {
    throw new Error(
      'Dynamic pricing (unitAmount) is not supported for subscriptions. Use a Stripe priceId.'
    );
  }

  if (priceId) {
    // Fixed pricing: validate priceId matches config (if config has one)
    if (billingItem.priceId && billingItem.priceId !== priceId) {
      throw new Error('Price ID mismatch with configuration');
    }
  } else {
    // Dynamic pricing: maxUnitAmount is required as a security cap
    if (!billingItem.maxUnitAmount) {
      throw new Error(
        'Dynamic pricing requires maxUnitAmount in billing config for security'
      );
    }
    if (unitAmount! > billingItem.maxUnitAmount) {
      throw new Error(
        `Unit amount ${unitAmount} exceeds maximum allowed: ${billingItem.maxUnitAmount}`
      );
    }
    if (unitAmount! < 100) {
      throw new Error('Unit amount must be at least 100 cents (1.00)');
    }
  }

  // ✅ VALIDATE: userId exists
  if (!userId) {
    throw new Error('Missing userId in request');
  }

  // Verify user exists
  await authProvider.getUser(userId);

  // ✅ HOOK: beforeCheckout (ownership check, status validation, server-resolved pricing)
  let finalUnitAmount = unitAmount;
  let finalProductName = productName;

  if (billingItem.beforeCheckout) {
    const hookResult = await billingItem.beforeCheckout(
      userId,
      {
        priceId,
        unitAmount,
        productName,
        currency,
        mode,
        metadata,
        allowPromotionCodes,
      },
      sanitizeMetadata(metadata)
    );

    if (!hookResult.allowed) {
      throw new Error(
        hookResult.reason || 'Checkout blocked by beforeCheckout hook'
      );
    }

    if (hookResult.overrides) {
      if (hookResult.overrides.unitAmount !== undefined) {
        finalUnitAmount = hookResult.overrides.unitAmount;
      }
      if (hookResult.overrides.productName !== undefined) {
        finalProductName = hookResult.overrides.productName;
      }
    }
  }

  const finalUseDynamicPricing =
    !priceId && finalUnitAmount && finalProductName;

  // ✅ VALIDATE: overridden amount still respects security cap
  if (
    finalUseDynamicPricing &&
    billingItem.maxUnitAmount &&
    finalUnitAmount! > billingItem.maxUnitAmount
  ) {
    throw new Error(
      `Hook-overridden unit amount ${finalUnitAmount} exceeds maximum allowed: ${billingItem.maxUnitAmount}`
    );
  }

  // ✅ VALIDATE: URLs are valid http/https
  const resolvedSuccessUrl =
    successUrl || `${process.env.FRONTEND_URL}/billing/success`;
  const resolvedCancelUrl =
    cancelUrl || `${process.env.FRONTEND_URL}/billing/cancel`;
  validateCheckoutUrl(resolvedSuccessUrl, 'success');
  validateCheckoutUrl(resolvedCancelUrl, 'cancel');

  // ✅ SANITIZE: metadata values (strip scripts, cap lengths)
  const sanitizedMetadata = sanitizeMetadata(metadata);

  // Create checkout session
  const session = await stripeProvider.createCheckoutSession({
    priceId,
    unitAmount: finalUseDynamicPricing ? finalUnitAmount : undefined,
    productName: finalUseDynamicPricing ? finalProductName : undefined,
    currency: currency || billingItem.currency || 'eur',
    customerEmail,
    metadata: {
      ...sanitizedMetadata,
      userId,
      billingConfigKey: configKey as string, // ✅ Server values AFTER spread — cannot be overwritten by client
    },
    allowPromotionCodes,
    successUrl: resolvedSuccessUrl,
    cancelUrl: resolvedCancelUrl,
    mode,
  });

  return {
    sessionId: session.id,
    sessionUrl: session.url,
  };
}
