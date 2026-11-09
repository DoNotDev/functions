// packages/functions/src/vercel/__tests__/firebaseOptional.test.ts

/**
 * @fileoverview Regression test: the Vercel entry loads without Firebase
 * @description `firebase-admin` and `firebase-functions` are optional peers. A
 * Supabase-only Vercel app does not install them, so nothing reachable from
 * `@donotdev/functions/vercel` may import them (or `@donotdev/firebase/server`)
 * at module load. Every Firebase module is mocked to throw on load; the entry
 * and the Supabase billing backend must still load and resolve.
 *
 * vitest isolates the module registry per test file, so the mocks below
 * cannot leak into suites that load Firebase for real.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import { describe, expect, it, vi } from 'vitest';

function blocked(name: string): never {
  throw new Error(`${name} must not be loaded on the Supabase path`);
}

vi.mock('firebase-admin', () => blocked('firebase-admin'));
vi.mock('firebase-admin/app', () => blocked('firebase-admin/app'));
vi.mock('firebase-admin/auth', () => blocked('firebase-admin/auth'));
vi.mock('firebase-admin/firestore', () => blocked('firebase-admin/firestore'));
vi.mock('firebase-admin/functions', () => blocked('firebase-admin/functions'));
vi.mock('firebase-functions', () => blocked('firebase-functions'));
vi.mock('firebase-functions/v2', () => blocked('firebase-functions/v2'));
vi.mock('firebase-functions/v2/https', () => blocked('firebase-functions/v2/https'));
vi.mock('firebase-functions/params', () => blocked('firebase-functions/params'));
vi.mock('@donotdev/firebase/server', () => blocked('@donotdev/firebase/server'));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { admin: { getUserById: async () => ({ data: {}, error: null }) } },
    from: () => ({}),
  }),
}));

describe('vercel entry without firebase', () => {
  it('loads the whole @donotdev/functions/vercel entry', async () => {
    const entry = await import('../api/index.js');
    expect(typeof entry.createStripeWebhook).toBe('function');
    expect(typeof entry.createCheckoutSession).toBe('function');
    expect(typeof entry.refreshSubscriptionStatus).toBe('function');
  });

  it('builds Supabase billing handlers and resolves the supabase backend', async () => {
    process.env.SUPABASE_URL = 'https://example.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test';
    const entry = await import('../api/index.js');
    const { resolveBillingBackend } = await import('../api/billing/backend.js');

    expect(typeof entry.createCheckoutSession({}, { backend: 'supabase' })).toBe(
      'function'
    );
    const resolved = await resolveBillingBackend('supabase');
    expect(typeof resolved.authProvider.getUser).toBe('function');
    expect(typeof resolved.idempotencyStore).toBe('object');
  });
});
