# @donotdev/functions

## Unreleased

### Patch Changes

- **Breaking:** removed 0.1.x dynamic pricing (`unitAmount` + `productName`, `maxUnitAmount`, `beforeCheckout` `overrides`). Use a `priceId` or StripeOrder.
- **Breaking:** removed deprecated APIs: `registerCrudFunctions`, `createIdempotencyStore`, `resetIdempotencyStore`, `LegacyIdempotencyStore`, `checkAndReserve`, `isProcessed`, and the `shared/utils` auth and subscription wrappers.
- **Breaking:** `processWebhook` requires its `idempotencyStore` argument (`createFirestoreIdempotencyStore()` or `createSupabaseIdempotencyStore(...)`). The 7-argument 0.1.x call no longer falls back to Firestore auto-detection. `createIdempotencyStore` stays exported, deprecated.
- Removed the unused `validateStripeEnvironment` from `@donotdev/functions/shared`.
- Supabase CRUD list pagination imports `Buffer` from `node:buffer`: Supabase Edge Runtime has no global `Buffer`.
- The server logger no longer throws on import when `window` exists: Supabase Edge Runtime defines it, which failed every edge function with `WORKER_ERROR`.
- Supabase CRUD functions no longer load the Stripe SDK, and the Supabase Stripe webhook no longer loads `firebase-admin`.
- StripeOrder: `resolveLineItems` may return per-order session options (`ResolvedOrder.session`): `taxRateIds` (manual tax; `[]` = no tax for reverse charge; exclusive check), `paymentMethodTypes` (replaces `paymentMethodConfiguration`), `expiresAt` (30 min – 24 h, Stripe window) and `invoiceFooter`. Validated before Stripe is called; omitted options keep the back-config behaviour.
- `@donotdev/functions/supabase` exports `createCheckoutAlgorithm`, `StripeSessionProvider`, `CheckoutSessionResult`, `STRIPE_API_VERSION_PIN`, `handleEmailRequest`, `createResendProvider` and `EmailProviderAdapter` for app-specific checkout entry points and server-side emails.

## 0.1.45

### Patch Changes

- Vercel entry no longer imports `firebase-admin`, `firebase-functions` or `@donotdev/firebase/server` at module load: Firebase is loaded on the Firebase code path only, so Supabase-only Vercel apps load without the optional Firebase peers. Shared rate limiter and monitoring log through the framework logger instead of the `firebase-functions` logger.
- `backend` / auth provider is validated at runtime (`'firebase' | 'supabase'`): an unknown value throws `DoNotDevError` (`invalid-argument`) instead of silently running as Firebase. New exports `AuthBackendSchema` and `parseAuthBackend`.
- `refreshSubscriptionStatus` is now actually exported from `@donotdev/functions/vercel` (`export *` dropped the default export).
- Checkout keeps 0.1.x behaviour for StripePayment/StripeSubscription: a request `priceId` is used (and must match the back-config `priceId` when one is set), 0.1.x dynamic pricing (`unitAmount` + `productName`, capped by `maxUnitAmount`, `beforeCheckout` overrides) works again, and a request `mode` is honoured (omitted: derived from the item type). Items without a back-config `priceId` no longer always throw.
- `beforeCheckout` receives the 0.1.x options again (`mode`, `priceId`, `unitAmount`, `productName`, `currency`, `metadata`, `allowPromotionCodes`) alongside `billingConfigKey` / `lineItems`, so guards such as `options.mode === 'subscription'` work.
- `createCheckoutAlgorithm` accepts the 0.1.x call shape `(request, stripeProvider, authProvider, billingConfig)` (userId from `request.userId`) and 0.1.x `StripeCheckoutProvider` (`createCheckoutSession` with 0.1.x params, single-price items). StripeOrder needs the new `StripeSessionProvider` (`createStripeSession` + `retrieveTaxRate`), used by the Firebase, Supabase and Vercel handlers.
- Checkout metadata is checked against Stripe's limits (50 keys incl. server keys, keys ≤ 40 characters without `[` `]`, values ≤ 500 characters) on every Stripe object it is copied to, with a clear error before Stripe is called. 0.1.x allowed up to 100/1000 characters, which Stripe rejected with a 400 anyway.
- StripeOrder manual tax rejects inclusive Tax Rates (they would override `tax_behavior: 'exclusive'` and carve VAT out of the unit amount); each rate is retrieved once per instance. `orderId` (sent as `client_reference_id`) is capped at 200 characters.
- The Vercel entry no longer reaches `@donotdev/firebase/server` at module load through `shared/utils.ts`: `verifyFirebaseAuthToken` and `findReferences` import it lazily; the unused internal `getFirestore()` / `getAuth()` helpers of that file are removed (not exported by any entry).
- Webhook idempotency has three states: `IdempotencyStore.reserve(eventId)` returns `reserved` (with an owner token), `processed` (2xx skip) or `in_progress` (another delivery holds a live lease: `processWebhook` throws `unavailable`, the handler answers non-2xx and Stripe retries). Before, a delivery arriving during a live lease was acknowledged with 200 and the event was lost if that worker died.
- `markProcessed(eventId, ownerToken)` / `release(eventId, ownerToken)` take the owner token: only the owner may change its reservation. A stale owner's `release` is a logged no-op (`false`); its `markProcessed` throws `ReservationLostError`. Supabase `markProcessed` on 0 owned rows fails loud instead of succeeding silently.
- `markProcessed` runs in the controlled flow after a successful route, retried up to 3 times; if it still fails the webhook answers non-2xx WITHOUT releasing, so the event is re-run after the lease (at-least-once). Order and billing hooks must be idempotent on `ctx.orderId` / `ctx.eventId` (documented on the hook types). Routing errors are logged with their real message before being sanitised.
- Reservation lease raised from 10 to 70 minutes (`RESERVATION_LEASE_MS`): above the longest platform request timeout (Firebase gen2 HTTP 60 min; Vercel 30 min extended; Supabase Edge 400 s), so a live worker is never overtaken.
- StripePayment / StripeSubscription grant only once paid: `checkout.session.completed` with `payment_status` `paid` / `no_payment_required`, else `checkout.session.async_payment_succeeded` (SEPA and other delayed methods); `unpaid` completion and `async_payment_failed` are logged, nothing is granted; an unknown `payment_status` fails loud.
- Retention: Firestore `webhook_idempotency.expiresAt` is a Firestore `Timestamp` (30 days), so a TTL policy on that field deletes old documents (0.1.x numeric values are still read). Postgres: `webhook_events` gains `owner_token`, the RPCs `webhook_event_mark_processed` / `webhook_event_release`, `webhook_event_reserve` returns `'reserved' | 'processed' | 'in_progress'`, and a daily pg_cron job `cleanup-webhook-events` (5 AM UTC) deletes rows older than 30 days.
- The `webhook_events` RPCs no longer `REVOKE EXECUTE` from `anon` / `authenticated`: on Supabase Postgres 17.6.1.x a permission-denied function call by those roles crashes the backend (signal 11) and restarts every connection. The functions are `SECURITY INVOKER` and refuse every role but `service_role` in-function (`insufficient_privilege`); RLS still blocks direct table access.
- Default Stripe API version (`STRIPE_API_VERSION` unset) is `2025-02-24.acacia` (`STRIPE_API_VERSION_PIN`, also `MIN_ORDER_API_VERSION`); the previous `2024-12-18.acacia` fallback was below the StripeOrder minimum. The StripeOrder version error now says that payloads follow the webhook endpoint's API version and how to create an endpoint pinned to it.

## 0.1.43

### Patch Changes

- 59d99d4: Fix CORS preflight failure on Supabase CRUD dispatcher. The serve dispatcher now uses createEdgeFunction({ requireAuth: false }) for CORS handling, consistent with all other edge functions.
- a4c57d7: bugfixes and performance upgrades
- Updated dependencies [6b68659]
- Updated dependencies [98d641c]
- Updated dependencies [a4c57d7]
  - @donotdev/supabase@0.1.43
  - @donotdev/core@0.1.43
  - @donotdev/firebase@0.1.43
