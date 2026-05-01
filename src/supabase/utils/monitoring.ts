// packages/functions/src/supabase/utils/monitoring.ts

/**
 * @fileoverview Monitoring and metrics utilities for Supabase Edge Functions
 * @description Provides metrics collection and analytics queries using Postgres table
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Operation metrics data structure
 */
export interface OperationMetrics {
  operation: string;
  userId?: string;
  status: 'success' | 'failed' | 'pending';
  durationMs?: number;
  metadata?: Record<string, any>;
  errorCode?: string;
  errorMessage?: string;
}

/**
 * Record operation metrics for monitoring
 *
 * @param supabaseAdmin - Supabase admin client
 * @param metrics - Operation metrics to record
 */
export async function recordOperationMetrics(
  supabaseAdmin: SupabaseClient,
  metrics: OperationMetrics
): Promise<void> {
  try {
    const { error } = await supabaseAdmin.from('operation_metrics').insert({
      operation: metrics.operation,
      user_id: metrics.userId || null,
      status: metrics.status,
      duration_ms: metrics.durationMs || null,
      metadata: metrics.metadata || null,
      error_code: metrics.errorCode || null,
      error_message: metrics.errorMessage || null,
    });

    if (error) {
      console.error('[monitoring] Record failed:', error);
      // Don't throw - metrics failure shouldn't break the operation
    }
  } catch (error) {
    console.error('[monitoring] Record failed:', error);
    // Don't throw - metrics failure shouldn't break the operation
  }
}

/**
 * Get failure rate for an operation
 *
 * @param supabaseAdmin - Supabase admin client
 * @param operation - Operation name
 * @param hours - Time window in hours (default: 24)
 * @returns Failure rate (0-100)
 */
export async function getFailureRate(
  supabaseAdmin: SupabaseClient,
  operation: string,
  hours: number = 24
): Promise<number> {
  try {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);

    const { data, error } = await supabaseAdmin
      .from('operation_metrics')
      .select('status')
      .eq('operation', operation)
      .gte('timestamp', cutoffTime.toISOString());

    if (error || !data || data.length === 0) {
      return 0;
    }

    const failed = data.filter((m) => m.status === 'failed').length;
    return (failed / data.length) * 100;
  } catch (error) {
    console.error('[monitoring] Get failure rate failed:', error);
    return 0;
  }
}

/**
 * Get operation counts by user
 *
 * @param supabaseAdmin - Supabase admin client
 * @param userId - User ID
 * @param hours - Time window in hours (default: 24)
 * @returns Record of operation names to counts
 */
export async function getOperationCounts(
  supabaseAdmin: SupabaseClient,
  userId: string,
  hours: number = 24
): Promise<Record<string, number>> {
  try {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);

    const { data, error } = await supabaseAdmin
      .from('operation_metrics')
      .select('operation')
      .eq('user_id', userId)
      .gte('timestamp', cutoffTime.toISOString());

    if (error || !data) {
      return {};
    }

    const counts: Record<string, number> = {};
    for (const metric of data) {
      counts[metric.operation] = (counts[metric.operation] || 0) + 1;
    }

    return counts;
  } catch (error) {
    console.error('[monitoring] Get operation counts failed:', error);
    return {};
  }
}

/**
 * Get slow operations (above threshold)
 *
 * @param supabaseAdmin - Supabase admin client
 * @param thresholdMs - Duration threshold in milliseconds
 * @param hours - Time window in hours (default: 24)
 * @returns Array of operations with average duration
 */
export async function getSlowOperations(
  supabaseAdmin: SupabaseClient,
  thresholdMs: number,
  hours: number = 24
): Promise<Array<{ operation: string; avgDuration: number; count: number }>> {
  try {
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);

    const { data, error } = await supabaseAdmin
      .from('operation_metrics')
      .select('operation, duration_ms')
      .gte('timestamp', cutoffTime.toISOString())
      .not('duration_ms', 'is', null);

    if (error || !data) {
      return [];
    }

    // Group by operation and calculate average
    const grouped: Record<string, { sum: number; count: number }> = {};
    for (const metric of data) {
      if (!metric.duration_ms) continue;
      if (!grouped[metric.operation]) {
        grouped[metric.operation] = { sum: 0, count: 0 };
      }
      grouped[metric.operation].sum += metric.duration_ms;
      grouped[metric.operation].count += 1;
    }

    const results: Array<{
      operation: string;
      avgDuration: number;
      count: number;
    }> = [];
    for (const [operation, stats] of Object.entries(grouped)) {
      const avgDuration = stats.sum / stats.count;
      if (avgDuration >= thresholdMs) {
        results.push({
          operation,
          avgDuration: Math.round(avgDuration),
          count: stats.count,
        });
      }
    }

    return results.sort((a, b) => b.avgDuration - a.avgDuration);
  } catch (error) {
    console.error('[monitoring] Get slow operations failed:', error);
    return [];
  }
}
