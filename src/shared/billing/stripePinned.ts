// packages/functions/src/shared/billing/stripePinned.ts

/**
 * @fileoverview Typed access to Stripe fields of the pinned API version
 * @description The Stripe SDK types follow the latest API version only, while
 * requests run at `STRIPE_API_VERSION_PIN` (pre-basil). Fields that basil
 * moved (subscription period, invoice subscription) are read here, through one
 * documented cast, instead of `as any` at every call site. Internal: not
 * re-exported from any package entry.
 *
 * @version 0.1.0
 * @since 0.2.2
 * @author AMBROISE PARK Consulting
 */

import type Stripe from 'stripe';

/** Subscription fields present at `STRIPE_API_VERSION_PIN`, dropped from the latest SDK types. */
interface PinnedSubscriptionFields {
  current_period_start: number;
  current_period_end: number;
}

/** Invoice fields present at `STRIPE_API_VERSION_PIN`, dropped from the latest SDK types. */
interface PinnedInvoiceFields {
  /** Not expanded in webhook payloads: the subscription id, or null for one-off invoices. */
  subscription: string | null;
}

/**
 * Period fields of a subscription at the pinned API version.
 *
 * @version 0.1.0
 * @since 0.2.2
 * @author AMBROISE PARK Consulting
 */
export function pinnedSubscriptionPeriod(
  subscription: Stripe.Subscription
): PinnedSubscriptionFields {
  // why: SDK v20 types track the latest API (period moved to items); runtime is pinned pre-basil
  return subscription as unknown as PinnedSubscriptionFields;
}

/**
 * Subscription id of an invoice at the pinned API version.
 *
 * @version 0.1.0
 * @since 0.2.2
 * @author AMBROISE PARK Consulting
 */
export function pinnedInvoiceSubscriptionId(
  invoice: Stripe.Invoice
): string | null {
  // why: SDK v20 types track the latest API (moved to invoice.parent); runtime is pinned pre-basil
  return (invoice as unknown as PinnedInvoiceFields).subscription;
}

/**
 * Narrows a value to one of a readonly list of literals.
 *
 * @version 0.1.0
 * @since 0.2.2
 * @author AMBROISE PARK Consulting
 */
export function isOneOf<T extends string>(
  values: readonly T[],
  value: string
): value is T {
  const list: readonly string[] = values;
  return list.includes(value);
}
