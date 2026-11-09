// packages/functions/src/vercel/api/billing/backend.ts

/**
 * @fileoverview Backend wiring for Vercel billing handlers
 * @description Vercel functions run against either Firebase or Supabase. The
 * backend decides token verification, rate limiting, user claims and webhook
 * idempotency storage. It is always explicit: there is no auto-detection.
 * Firebase modules are imported on the Firebase path only: `firebase-admin`
 * and `firebase-functions` are optional peers a Supabase app does not install.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type { BillingAuthProvider } from '@donotdev/core/server';

import {
  createFirestoreIdempotencyStore,
  createSupabaseIdempotencyStore,
} from '../../../shared/billing/idempotency.js';
import type { IdempotencyStore } from '../../../shared/billing/idempotency.js';
import { parseAuthBackend } from '../../../shared/utils/internal/auth.js';
import type { AuthProvider as AuthBackend } from '../../../shared/utils/internal/auth.js';
import { createSupabaseAuthProvider } from '../../../supabase/helpers/authProvider.js';
import { getSupabaseAdmin } from '../../supabaseAdmin.js';

/**
 * Options of the Vercel billing handler factories.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export interface VercelBillingOptions {
  /** Auth and data backend of the app (validated at runtime) */
  backend: AuthBackend;
}

/**
 * Resolve the user-claims provider and the webhook idempotency store of a backend.
 *
 * @throws DoNotDevError (`invalid-argument`) when `backend` is not `'firebase'` or `'supabase'`
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export async function resolveBillingBackend(
  backend: VercelBillingOptions['backend']
): Promise<{ authProvider: BillingAuthProvider; idempotencyStore: IdempotencyStore }> {
  if (parseAuthBackend(backend) === 'supabase') {
    const supabaseAdmin = await getSupabaseAdmin();
    return {
      authProvider: createSupabaseAuthProvider(supabaseAdmin),
      idempotencyStore: createSupabaseIdempotencyStore(supabaseAdmin),
    };
  }
  const { getFirebaseAdminAuth } = await import('@donotdev/firebase/server');
  return {
    authProvider: {
      async getUser(userId) {
        const user = await getFirebaseAdminAuth().getUser(userId);
        return { customClaims: user.customClaims };
      },
      async setCustomUserClaims(userId, claims) {
        await getFirebaseAdminAuth().setCustomUserClaims(userId, claims);
      },
    },
    idempotencyStore: createFirestoreIdempotencyStore(),
  };
}
