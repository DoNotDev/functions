// packages/functions/src/supabase/utils/idempotency.ts

/**
 * @fileoverview Idempotency utilities for Supabase Edge Functions
 * @description Provides idempotency checking and storage using Postgres table
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Default TTL for idempotency records (24 hours)
 */
const DEFAULT_TTL_HOURS = 24;

/**
 * TTL per operation type (hours)
 */
const OPERATION_TTL: Record<string, number> = {
  create: 24,
  update: 12,
  delete: 1,
  default: 24,
};

/**
 * Check if an operation has already been processed (idempotency check)
 *
 * @param supabaseAdmin - Supabase admin client
 * @param idempotencyKey - Client-provided idempotency key
 * @param operation - Operation name (e.g., 'create', 'update')
 * @returns Cached result if found, null otherwise
 */
export async function checkIdempotency<T>(
  supabaseAdmin: SupabaseClient,
  idempotencyKey: string,
  operation: string
): Promise<T | null> {
  try {
    const id = `${operation}_${idempotencyKey}`;

    const { data, error } = await supabaseAdmin
      .from('idempotency')
      .select('result')
      .eq('idempotency_key', idempotencyKey)
      .eq('operation', operation)
      .gt('expires_at', new Date().toISOString())
      .single();

    if (error || !data) {
      return null;
    }

    return data.result as T;
  } catch (error) {
    // Fail closed — in billing context, allowing a duplicate operation is worse
    // than rejecting a legitimate retry. Throw so the caller surfaces an error
    // rather than silently double-processing a payment.
    console.error('[idempotency] Check failed:', error);
    throw new Error(
      '[idempotency] Unable to verify idempotency. Operation rejected to prevent potential duplicate processing.'
    );
  }
}

/**
 * Store the result of an operation for idempotency
 *
 * @param supabaseAdmin - Supabase admin client
 * @param idempotencyKey - Client-provided idempotency key
 * @param operation - Operation name (e.g., 'create', 'update')
 * @param result - Operation result to cache
 * @param uid - User ID who processed the operation
 * @param ttlHours - Optional TTL override (defaults to operation-specific TTL)
 */
export async function storeIdempotency<T>(
  supabaseAdmin: SupabaseClient,
  idempotencyKey: string,
  operation: string,
  result: T,
  uid: string,
  ttlHours?: number
): Promise<void> {
  try {
    const id = `${operation}_${idempotencyKey}`;
    const ttl = ttlHours ?? OPERATION_TTL[operation] ?? OPERATION_TTL.default;
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + ttl);

    const { error } = await supabaseAdmin.from('idempotency').upsert(
      {
        id,
        operation,
        idempotency_key: idempotencyKey,
        result: result as any,
        processed_by: uid,
        expires_at: expiresAt.toISOString(),
      },
      {
        onConflict: 'idempotency_key',
      }
    );

    if (error) {
      console.error('[idempotency] Store failed:', error);
      // Don't throw - idempotency storage failure shouldn't break the operation
    }
  } catch (error) {
    console.error('[idempotency] Store failed:', error);
    // Don't throw - idempotency storage failure shouldn't break the operation
  }
}

/**
 * Clean up expired idempotency records
 *
 * @param supabaseAdmin - Supabase admin client
 * @returns Number of deleted records
 */
export async function cleanupExpiredIdempotency(
  supabaseAdmin: SupabaseClient
): Promise<number> {
  try {
    const { data, error } = await supabaseAdmin
      .from('idempotency')
      .delete()
      .lt('expires_at', new Date().toISOString())
      .select('id');

    if (error) {
      console.error('[idempotency] Cleanup failed:', error);
      return 0;
    }

    return data?.length ?? 0;
  } catch (error) {
    console.error('[idempotency] Cleanup failed:', error);
    return 0;
  }
}
