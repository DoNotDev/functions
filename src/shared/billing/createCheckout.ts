// packages/functions/src/shared/billing/createCheckout.ts

/**
 * @fileoverview Create Checkout Session Algorithm
 * @description Platform-agnostic algorithm for creating Stripe checkout sessions.
 * StripePayment/StripeSubscription items keep the 0.1.x behaviour (request or
 * back-config priceId). StripeOrder items are priced on
 * the server (`resolveLineItems`) and need a {@link StripeSessionProvider}.
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

import type {
  BeforeCheckoutOptions,
  CheckoutSessionParams,
  CheckoutSessionResult,
  CreateCheckoutSessionRequest,
  CreateCheckoutSessionRequestInput,
  CreateCheckoutSessionResponse,
  ResolvedOrder,
  StripeBackConfig,
  StripeCheckoutProvider,
  StripeOrderBackItem,
} from '@donotdev/core/server';

import { resolvePricePlan, toStripeSessionParams } from './checkoutPrice.js';
import {
  assertCheckoutSessionMetadata,
  assertExclusiveTaxRates,
  assertResolvedOrder,
  assertStripeMetadata,
  sanitizeMetadata,
  validateCheckoutUrl,
} from './checkoutValidation.js';
import {
  ORDER_ID_METADATA_KEY,
  PRODUCT_ID_METADATA_KEY,
} from './orderWebhook.js';

/**
 * Provider that sends full Stripe session params (every item type, StripeOrder included).
 *
 * @example
 * ```typescript
 * const provider: StripeSessionProvider = {
 *   async createStripeSession(params) {
 *     const session = await stripe.checkout.sessions.create(params);
 *     return { id: session.id, url: session.url };
 *   },
 *   async retrieveTaxRate(id) {
 *     const rate = await stripe.taxRates.retrieve(id);
 *     return { id: rate.id, inclusive: rate.inclusive };
 *   },
 * };
 * ```
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export interface StripeSessionProvider {
  createStripeSession(
    params: Stripe.Checkout.SessionCreateParams
  ): Promise<CheckoutSessionResult>;
  /** Used to reject inclusive Tax Rates on StripeOrder manual tax (cached per instance). */
  retrieveTaxRate(taxRateId: string): Promise<{ id: string; inclusive: boolean }>;
}

/**
 * Any provider accepted by {@link createCheckoutAlgorithm}.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export type CheckoutProvider = StripeCheckoutProvider | StripeSessionProvider;

/**
 * Provider interface for authentication operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface AuthCheckoutProvider {
  getUser(userId: string): Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: exported signature; narrowing it is a breaking change for importers (deferred to a major, any-audit 2026-11-11)
    customClaims?: Record<string, any>;
  }>;
}

function isSessionProvider(
  provider: CheckoutProvider
): provider is StripeSessionProvider {
  return 'createStripeSession' in provider;
}

/** 0.1.x: empty redirect URLs default to FRONTEND_URL pages. */
function resolveRedirectUrl(url: string, path: string): string {
  if (url) return url;
  const frontendUrl = process.env.FRONTEND_URL;
  if (!frontendUrl) {
    throw new Error(`Missing ${path} redirect URL and FRONTEND_URL is not set`);
  }
  return `${frontendUrl}/billing/${path}`;
}

/** Common session params for StripeOrder. */
interface BaseSessionParams {
  successUrl: string;
  cancelUrl: string;
  customerEmail: string | undefined;
  metadata: Record<string, string>;
}

/**
 * What Checkout writes back to an existing Customer (`customer_update`):
 * - `address` under automatic tax: Stripe Tax needs an address on the Customer, the
 *   billing address entered at checkout replaces the saved one;
 * - `shipping` when shipping is collected (Stripe: needs shipping_address_collection);
 * - `name` when tax ID collection is enabled (Stripe: required for existing customers).
 * Undefined when nothing applies (manual tax, no shipping, no tax ID collection).
 */
function customerUpdate(
  item: StripeOrderBackItem,
  taxIdCollectionEnabled: boolean
): Stripe.Checkout.SessionCreateParams.CustomerUpdate | undefined {
  const update: Stripe.Checkout.SessionCreateParams.CustomerUpdate = {
    ...(item.tax.mode === 'automatic' && { address: 'auto' }),
    ...(item.shipping && { shipping: 'auto' }),
    ...(taxIdCollectionEnabled && { name: 'auto' }),
  };
  return Object.keys(update).length > 0 ? update : undefined;
}

/**
 * Session params for a StripeOrder: server-priced lines (excl. VAT) and the
 * item's B2B options.
 */
function buildOrderSessionParams(
  item: StripeOrderBackItem,
  order: ResolvedOrder,
  base: BaseSessionParams
): Stripe.Checkout.SessionCreateParams {
  const options = order.session ?? {};
  const taxRates =
    item.tax.mode === 'manual'
      ? (options.taxRateIds ?? item.tax.taxRateIds)
      : undefined;
  const metadata = { ...base.metadata, [ORDER_ID_METADATA_KEY]: order.orderId };
  const taxIdCollectionEnabled = item.taxIdCollection !== 'disabled';
  const update = customerUpdate(item, taxIdCollectionEnabled);

  // Existing Customer: Stripe applies customer_email / customer_creation only when it
  // creates a Customer, so they are replaced by customer + customer_update.
  const customerParams: Pick<
    Stripe.Checkout.SessionCreateParams,
    'customer' | 'customer_update' | 'customer_email' | 'customer_creation'
  > = options.customerId
    ? {
        customer: options.customerId,
        ...(update && { customer_update: update }),
      }
    : {
        customer_creation: item.customerCreation,
        customer_email: base.customerEmail,
      };

  return {
    mode: 'payment',
    client_reference_id: order.orderId,
    line_items: order.lineItems.map((line) => ({
      price_data: {
        currency: item.currency,
        unit_amount: line.unitAmount,
        tax_behavior: 'exclusive',
        product_data: {
          name: line.name,
          ...(line.description && { description: line.description }),
          ...(line.taxCode && { tax_code: line.taxCode }),
          metadata: { [PRODUCT_ID_METADATA_KEY]: line.productId },
        },
      },
      quantity: line.quantity,
      ...(taxRates && taxRates.length > 0 && { tax_rates: taxRates }),
    })),
    automatic_tax: { enabled: item.tax.mode === 'automatic' },
    tax_id_collection: taxIdCollectionEnabled
      ? {
          enabled: true,
          required:
            item.taxIdCollection === 'required' ? 'if_supported' : 'never',
        }
      : { enabled: false },
    billing_address_collection: item.billingAddressCollection,
    ...(item.shipping && {
      shipping_address_collection: {
        // Config validated as uppercase ISO 3166-1 alpha-2; stripe@20 types the param as a closed enum
        allowed_countries: item.shipping
          .allowedCountries as Stripe.Checkout.SessionCreateParams.ShippingAddressCollection.AllowedCountry[],
      },
      ...(item.shipping.shippingRateIds && {
        shipping_options: item.shipping.shippingRateIds.map((id) => ({
          shipping_rate: id,
        })),
      }),
    }),
    ...customerParams,
    invoice_creation: {
      enabled: item.invoiceCreation,
      ...(item.invoiceCreation && {
        invoice_data: {
          metadata,
          ...(options.invoiceFooter && { footer: options.invoiceFooter }),
        },
      }),
    },
    // Per-order methods replace the configuration (Stripe accepts one or the other)
    ...(options.paymentMethodTypes
      ? { payment_method_types: options.paymentMethodTypes }
      : item.paymentMethodConfiguration && {
          payment_method_configuration: item.paymentMethodConfiguration,
        }),
    ...(options.expiresAt !== undefined && { expires_at: options.expiresAt }),
    // Orders: merchant policy from the back config only
    allow_promotion_codes: item.allowPromotionCodes === true,
    success_url: base.successUrl,
    cancel_url: base.cancelUrl,
    metadata,
    payment_intent_data: { metadata },
  };
}

type CheckoutArgs =
  | [CheckoutProvider, AuthCheckoutProvider, StripeBackConfig]
  | [string, CheckoutProvider, AuthCheckoutProvider, StripeBackConfig];

/**
 * Create checkout session algorithm
 *
 * 1. Resolve the billing config item and verify the user
 * 2. Single-price items: 0.1.x pricing (request/back-config priceId)
 * 3. `beforeCheckout` hook (block/allow)
 * 4. StripeOrder: reject inclusive manual Tax Rates, `resolveLineItems` prices every line
 *    and may set per-order session options (`ResolvedOrder.session`: tax rates,
 *    payment methods, expiry, invoice footer, existing Stripe customer)
 * 5. Validate metadata against Stripe limits, create the session through the provider
 *
 * Server-owned metadata (`userId`, `billingConfigKey`, `orderId`) is written after
 * the client metadata and cannot be overwritten by it.
 *
 * Two call shapes:
 * - `(request, userId, stripeProvider, authProvider, billingConfig)`: userId from
 *   the provider's auth context (framework providers use this).
 * - 0.1.x `(request, stripeProvider, authProvider, billingConfig)`: userId read from
 *   `request.userId` (the caller must set it from its auth context).
 *
 * @example
 * ```typescript
 * const result = await createCheckoutAlgorithm(
 *   request,
 *   context.uid,
 *   stripeSessionProvider,
 *   authProvider,
 *   billingConfig
 * );
 * ```
 *
 * @param request - Validated client request (0.1.x shape accepted)
 * @param userId - Authenticated user ID (omit in the 0.1.x call shape)
 * @param stripeProvider - {@link StripeSessionProvider}, or 0.1.x {@link StripeCheckoutProvider} (single-price items only)
 * @param authProvider - Verifies the user exists
 * @param billingConfig - App back config
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function createCheckoutAlgorithm(
  request: CreateCheckoutSessionRequestInput,
  userId: string,
  stripeProvider: CheckoutProvider,
  authProvider: AuthCheckoutProvider,
  billingConfig: StripeBackConfig
): Promise<CreateCheckoutSessionResponse>;
export async function createCheckoutAlgorithm(
  request: CreateCheckoutSessionRequestInput,
  stripeProvider: CheckoutProvider,
  authProvider: AuthCheckoutProvider,
  billingConfig: StripeBackConfig
): Promise<CreateCheckoutSessionResponse>;
export async function createCheckoutAlgorithm(
  input: CreateCheckoutSessionRequestInput,
  ...args: CheckoutArgs
): Promise<CreateCheckoutSessionResponse> {
  const legacyCall = args.length === 3;
  const [userId, stripeProvider, authProvider, billingConfig] =
    args.length === 3 ? [input.userId, ...args] : args;
  if (!userId) {
    throw new Error(
      legacyCall ? 'Missing userId in request' : 'Missing authenticated userId'
    );
  }

  const billingConfigKey =
    input.billingConfigKey || input.metadata?.billingConfigKey;
  if (!billingConfigKey) {
    throw new Error('Missing billingConfigKey (request or metadata)');
  }
  const request: CreateCheckoutSessionRequest = {
    ...input,
    billingConfigKey,
    lineItems: input.lineItems ?? [{ productId: billingConfigKey, quantity: 1 }],
  };

  const billingItem = billingConfig[billingConfigKey];
  if (!billingItem) {
    throw new Error(`Invalid billing config key: ${billingConfigKey}`);
  }

  const isOrder = billingItem.type === 'StripeOrder';
  const plan = isOrder ? undefined : resolvePricePlan(billingItem, request);

  // Verify user exists
  await authProvider.getUser(userId);

  const clientMetadata = sanitizeMetadata(request.metadata ?? {});
  // Server values AFTER spread — cannot be overwritten by client
  const metadata = { ...clientMetadata, userId, billingConfigKey };
  // Fail before any hook side effect (StripeOrder creates a pending order)
  assertStripeMetadata(
    isOrder ? { ...metadata, [ORDER_ID_METADATA_KEY]: '' } : metadata,
    'metadata'
  );

  const allowPromotionCodes = request.allowPromotionCodes ?? true;

  if (billingItem.beforeCheckout) {
    const options: BeforeCheckoutOptions = {
      ...request,
      userId,
      mode: plan?.mode ?? 'payment',
      priceId: plan?.priceId,
      metadata: request.metadata ?? {},
      allowPromotionCodes,
    };
    const hookResult = await billingItem.beforeCheckout(
      userId,
      options,
      clientMetadata
    );
    if (!hookResult.allowed) {
      throw new Error(
        hookResult.reason || 'Checkout blocked by beforeCheckout hook'
      );
    }
  }

  const successUrl = resolveRedirectUrl(request.successUrl, 'success');
  const cancelUrl = resolveRedirectUrl(request.cancelUrl, 'cancel');
  validateCheckoutUrl(successUrl, 'success');
  validateCheckoutUrl(cancelUrl, 'cancel');

  let session: CheckoutSessionResult;
  if (billingItem.type === 'StripeOrder') {
    if (!isSessionProvider(stripeProvider)) {
      throw new Error(
        `'${billingConfigKey}' is a StripeOrder: the checkout provider must implement createStripeSession (StripeSessionProvider)`
      );
    }
    if (billingItem.tax.mode === 'manual') {
      await assertExclusiveTaxRates(
        (id) => stripeProvider.retrieveTaxRate(id),
        billingItem.tax.taxRateIds,
        billingConfigKey
      );
    }
    const order = await billingItem.resolveLineItems(request.lineItems, {
      userId,
      billingConfigKey,
      metadata: clientMetadata,
    });
    assertResolvedOrder(order, billingConfigKey);
    const sessionOptions = order.session;
    if (sessionOptions?.taxRateIds) {
      if (billingItem.tax.mode !== 'manual') {
        throw new Error(
          `resolveLineItems for '${billingConfigKey}': session.taxRateIds needs tax.mode 'manual'`
        );
      }
      await assertExclusiveTaxRates(
        (id) => stripeProvider.retrieveTaxRate(id),
        sessionOptions.taxRateIds,
        billingConfigKey
      );
    }
    if (
      billingItem.tax.mode !== 'automatic' &&
      order.lineItems.some((line) => line.taxCode !== undefined)
    ) {
      throw new Error(
        `resolveLineItems for '${billingConfigKey}': line taxCode needs tax.mode 'automatic'`
      );
    }
    if (sessionOptions?.invoiceFooter && !billingItem.invoiceCreation) {
      throw new Error(
        `resolveLineItems for '${billingConfigKey}': session.invoiceFooter needs invoiceCreation`
      );
    }
    const params = buildOrderSessionParams(billingItem, order, {
      successUrl,
      cancelUrl,
      customerEmail: request.customerEmail,
      metadata,
    });
    assertCheckoutSessionMetadata(params);
    session = await stripeProvider.createStripeSession(params);
  } else {
    const params: CheckoutSessionParams = {
      priceId: plan?.priceId,
      currency: request.currency || billingItem.currency || 'eur',
      customerEmail: request.customerEmail,
      metadata,
      allowPromotionCodes,
      successUrl,
      cancelUrl,
      mode: plan?.mode,
    };
    if (isSessionProvider(stripeProvider)) {
      const stripeParams = toStripeSessionParams(params);
      assertCheckoutSessionMetadata(stripeParams);
      session = await stripeProvider.createStripeSession(stripeParams);
    } else {
      session = await stripeProvider.createCheckoutSession(params);
    }
  }

  return {
    sessionId: session.id,
    sessionUrl: session.url,
  };
}
