// packages/functions/src/shared/billing/checkoutValidation.ts

/**
 * @fileoverview Checkout validation helpers
 * @description Fail-loud checks run by `createCheckoutAlgorithm` before calling
 * Stripe: redirect URLs, client metadata, Stripe metadata limits, resolved
 * StripeOrder lines and manual Tax Rates.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import type { ResolvedOrder, ResolvedOrderSession } from '@donotdev/core/server';

/** Stripe `client_reference_id` maximum length (Checkout Session create API). */
const MAX_CLIENT_REFERENCE_ID_LENGTH = 200;

/**
 * Stripe metadata limits (https://docs.stripe.com/metadata): 50 keys, keys up
 * to 40 characters without square brackets, values up to 500 characters.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const STRIPE_METADATA_LIMITS = {
  maxKeys: 50,
  maxKeyLength: 40,
  maxValueLength: 500,
} as const;

/**
 * Validate URL has http/https protocol.
 * Platform-agnostic (no firebase logger dependency).
 */
export function validateCheckoutUrl(url: string, name: string): void {
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
 * Sanitize client metadata: enforce string values, strip script injection.
 * Length limits are checked on the final metadata ({@link assertStripeMetadata}).
 */
export function sanitizeMetadata(
  metadata: Record<string, unknown>
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new Error(
        `Metadata value for key '${key}' must be a string, got ${typeof value}`
      );
    }

    sanitized[key] = value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '');
  }

  return sanitized;
}

/**
 * Throw a validation error when metadata exceeds Stripe's limits
 * ({@link STRIPE_METADATA_LIMITS}), instead of letting Stripe answer 400.
 *
 * @param metadata - Metadata as it will be sent to Stripe
 * @param target - Stripe param the metadata goes to (shown in the error)
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function assertStripeMetadata(
  metadata: Record<string, string | number | null>,
  target: string
): void {
  const { maxKeys, maxKeyLength, maxValueLength } = STRIPE_METADATA_LIMITS;
  const entries = Object.entries(metadata);
  if (entries.length > maxKeys) {
    throw new Error(
      `${target}: ${entries.length} metadata keys, Stripe allows at most ${maxKeys} (server keys included)`
    );
  }
  for (const [key, value] of entries) {
    if (key.length > maxKeyLength) {
      throw new Error(
        `${target}: metadata key '${key}' is too long (max ${maxKeyLength} characters)`
      );
    }
    if (/[[\]]/.test(key)) {
      throw new Error(
        `${target}: metadata key '${key}' must not contain square brackets`
      );
    }
    if (value !== null && String(value).length > maxValueLength) {
      throw new Error(
        `${target}: metadata value for key '${key}' is too long (max ${maxValueLength} characters)`
      );
    }
  }
}

/**
 * Check every metadata map of Checkout Session params (session, subscription,
 * payment intent, invoice, line products) against Stripe's limits.
 *
 * @param params - Session params about to be sent to Stripe
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function assertCheckoutSessionMetadata(
  params: Stripe.Checkout.SessionCreateParams
): void {
  const targets: Array<[string, Stripe.MetadataParam | '' | undefined]> = [
    ['metadata', params.metadata],
    ['subscription_data.metadata', params.subscription_data?.metadata],
    ['payment_intent_data.metadata', params.payment_intent_data?.metadata],
    [
      'invoice_creation.invoice_data.metadata',
      params.invoice_creation?.invoice_data?.metadata,
    ],
    ...(params.line_items ?? []).map(
      (line, i): [string, Stripe.MetadataParam | undefined] => [
        `line_items[${i}].price_data.product_data.metadata`,
        line.price_data?.product_data?.metadata,
      ]
    ),
  ];
  for (const [target, metadata] of targets) {
    if (metadata) assertStripeMetadata(metadata, target);
  }
}

/**
 * Validate the output of an app `resolveLineItems` hook. Fails loud on any
 * malformed line instead of sending it to Stripe.
 */
export function assertResolvedOrder(
  order: ResolvedOrder,
  configKey: string
): void {
  if (!order.orderId) {
    throw new Error(`resolveLineItems for '${configKey}' returned no orderId`);
  }
  if (order.orderId.length > MAX_CLIENT_REFERENCE_ID_LENGTH) {
    throw new Error(
      `resolveLineItems for '${configKey}': orderId is sent as client_reference_id (max ${MAX_CLIENT_REFERENCE_ID_LENGTH} characters), got ${order.orderId.length}`
    );
  }
  if (order.lineItems.length === 0) {
    throw new Error(`resolveLineItems for '${configKey}' returned no lines`);
  }
  if (order.session) assertResolvedOrderSession(order.session, configKey);
  for (const line of order.lineItems) {
    if (!line.productId || !line.name) {
      throw new Error(
        `resolveLineItems for '${configKey}' returned a line without productId or name`
      );
    }
    if (!Number.isInteger(line.unitAmount) || line.unitAmount < 0) {
      throw new Error(
        `Line '${line.productId}': unitAmount must be a non-negative integer (smallest currency unit), got ${line.unitAmount}`
      );
    }
    if (!Number.isInteger(line.quantity) || line.quantity < 1) {
      throw new Error(
        `Line '${line.productId}': quantity must be a positive integer, got ${line.quantity}`
      );
    }
    if (line.taxCode !== undefined && !STRIPE_TAX_CODE.test(line.taxCode)) {
      throw new Error(
        `Line '${line.productId}': taxCode must be a Stripe tax code (txcd_ + 8 digits), got '${line.taxCode}'`
      );
    }
  }
}

/** Stripe Checkout `expires_at` window (seconds after creation). */
export const CHECKOUT_EXPIRY_WINDOW = { minSeconds: 30 * 60, maxSeconds: 24 * 60 * 60 } as const;

/** Stripe invoice footer maximum length. */
const MAX_INVOICE_FOOTER_LENGTH = 5000;

const ORDER_PAYMENT_METHOD_TYPES = ['card', 'sepa_debit'] as const;

/** Stripe Customer ID shape. */
const STRIPE_CUSTOMER_ID = /^cus_[A-Za-z0-9]+$/;

/** Stripe tax code shape (https://docs.stripe.com/tax/tax-codes), e.g. `txcd_92010001`. */
const STRIPE_TAX_CODE = /^txcd_\d{8}$/;

/**
 * Validate per-order session options returned by `resolveLineItems`.
 * Item-dependent checks (manual tax, invoice creation) run in `createCheckoutAlgorithm`.
 *
 * @param session - `ResolvedOrder.session`
 * @param configKey - Back config key (shown in errors)
 * @param nowSeconds - Current Unix time (injectable for tests)
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export function assertResolvedOrderSession(
  session: ResolvedOrderSession,
  configKey: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): void {
  const { taxRateIds, paymentMethodTypes, expiresAt, invoiceFooter, customerId } =
    session;
  if (customerId !== undefined && !STRIPE_CUSTOMER_ID.test(customerId)) {
    throw new Error(
      `resolveLineItems for '${configKey}': session.customerId must be a Stripe Customer ID (cus_...), got '${customerId}'`
    );
  }
  if (taxRateIds && taxRateIds.some((id) => typeof id !== 'string' || id.length === 0)) {
    throw new Error(
      `resolveLineItems for '${configKey}': session.taxRateIds must be non-empty strings`
    );
  }
  if (paymentMethodTypes) {
    if (paymentMethodTypes.length === 0) {
      throw new Error(
        `resolveLineItems for '${configKey}': session.paymentMethodTypes must not be empty`
      );
    }
    for (const type of paymentMethodTypes) {
      if (!(ORDER_PAYMENT_METHOD_TYPES as readonly string[]).includes(type)) {
        throw new Error(
          `resolveLineItems for '${configKey}': unsupported payment method type '${type}'`
        );
      }
    }
  }
  if (expiresAt !== undefined) {
    const { minSeconds, maxSeconds } = CHECKOUT_EXPIRY_WINDOW;
    if (
      !Number.isInteger(expiresAt) ||
      expiresAt < nowSeconds + minSeconds ||
      expiresAt > nowSeconds + maxSeconds
    ) {
      throw new Error(
        `resolveLineItems for '${configKey}': session.expiresAt must be a Unix time 30 minutes to 24 hours from now (Stripe), got ${expiresAt}`
      );
    }
  }
  if (
    invoiceFooter !== undefined &&
    (invoiceFooter.length === 0 || invoiceFooter.length > MAX_INVOICE_FOOTER_LENGTH)
  ) {
    throw new Error(
      `resolveLineItems for '${configKey}': session.invoiceFooter must be 1 to ${MAX_INVOICE_FOOTER_LENGTH} characters`
    );
  }
}

/** Inclusive flag per Tax Rate ID: one Stripe call per ID per instance (cold start). */
const taxRateInclusiveCache = new Map<string, Promise<boolean>>();

/**
 * StripeOrder manual tax: unit amounts are excl. VAT, but an inclusive Tax Rate
 * overrides `price_data.tax_behavior: 'exclusive'` and carves the tax out of
 * the amount. Throws when any configured rate is inclusive.
 */
export async function assertExclusiveTaxRates(
  retrieveTaxRate: (id: string) => Promise<{ inclusive: boolean }>,
  taxRateIds: string[],
  configKey: string
): Promise<void> {
  for (const id of taxRateIds) {
    let inclusive = taxRateInclusiveCache.get(id);
    if (!inclusive) {
      inclusive = retrieveTaxRate(id).then((rate) => rate.inclusive);
      taxRateInclusiveCache.set(id, inclusive);
      // Failures are not cached: the next checkout retries
      inclusive.catch(() => taxRateInclusiveCache.delete(id));
    }
    if (await inclusive) {
      throw new Error(
        `'${configKey}': Tax Rate '${id}' is inclusive. StripeOrder unit amounts are excl. VAT: use an exclusive Tax Rate (inclusive: false).`
      );
    }
  }
}
