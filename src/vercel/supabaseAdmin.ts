// packages/functions/src/vercel/supabaseAdmin.ts

/**
 * @fileoverview Supabase admin client for Vercel functions
 * @description Lazily created service-role client for Vercel functions backed by
 * Supabase. `@supabase/supabase-js` is imported on first use only, so
 * Firebase-backed deployments never load it.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

/**
 * Get the service-role Supabase client (`SUPABASE_URL` + `SUPABASE_SECRET_KEY`
 * or the legacy `SUPABASE_SERVICE_ROLE_KEY`).
 *
 * @throws When the environment variables are missing
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export async function getSupabaseAdmin(): Promise<SupabaseClient> {
  if (cached) return cached;

  const supabaseUrl = process.env.SUPABASE_URL;
  const secretKey =
    process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !secretKey) {
    throw new Error(
      'Missing SUPABASE_URL or SUPABASE_SECRET_KEY/SUPABASE_SERVICE_ROLE_KEY environment variables'
    );
  }

  const { createClient } = await import('@supabase/supabase-js');
  cached = createClient(supabaseUrl, secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cached;
}
