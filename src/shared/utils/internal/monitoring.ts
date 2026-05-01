// packages/functions/src/shared/utils/internal/monitoring.ts

/**
 * @fileoverview Monitoring and alerting utilities for functions
 * @description Provides metrics collection and alerting for payment operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';

import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

/**
 * Payment metrics data structure
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface PaymentMetrics {
  operation: string;
  userId?: string;
  amount?: number;
  currency?: string;
  status: 'success' | 'failed' | 'pending';
  timestamp: string;
  metadata?: Record<string, any>;
}

/**
 * Alert threshold configuration
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface AlertThresholds {
  paymentFailureRate: number; // Percentage (0-100)
  paymentVolumeThreshold: number; // Daily volume threshold
  errorRateThreshold: number; // Percentage (0-100)
}

/**
 * Record payment metrics for monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function recordPaymentMetrics(
  metrics: PaymentMetrics
): Promise<void> {
  try {
    const db = getFirebaseAdminFirestore();
    const metricsRef = db.collection('payment_metrics').doc();
    await metricsRef.set({
      ...metrics,
      recordedAt: new Date().toISOString(),
    });

    logger.info('Payment metrics recorded', {
      operation: metrics.operation,
      status: metrics.status,
      userId: metrics.userId,
    });
  } catch (error) {
    logger.error('Failed to record payment metrics', {
      error: error instanceof Error ? error.message : String(error),
      metrics,
    });
    // Don't throw - metrics failure shouldn't break the operation
  }
}

/**
 * Check payment failure rate and trigger alerts if needed
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function checkPaymentFailureRate(
  timeWindowHours: number = 24
): Promise<{ failureRate: number; shouldAlert: boolean }> {
  try {
    const db = getFirebaseAdminFirestore();
    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - timeWindowHours);

    const metricsRef = db.collection('payment_metrics');
    const recentMetrics = await metricsRef
      .where('timestamp', '>=', cutoffTime.toISOString())
      .get();

    if (recentMetrics.empty) {
      return { failureRate: 0, shouldAlert: false };
    }

    const totalPayments = recentMetrics.size;
    const failedPayments = recentMetrics.docs.filter(
      (doc: any) => doc.data().status === 'failed'
    ).length;

    const failureRate = (failedPayments / totalPayments) * 100;
    const shouldAlert = failureRate > 10; // Alert if failure rate > 10%

    if (shouldAlert) {
      await triggerPaymentFailureAlert(
        failureRate,
        totalPayments,
        failedPayments
      );
    }

    return { failureRate, shouldAlert };
  } catch (error) {
    logger.error('Failed to check payment failure rate', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { failureRate: 0, shouldAlert: false };
  }
}

/**
 * Check daily payment volume and trigger alerts if needed
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function checkPaymentVolume(
  volumeThreshold: number = 10000 // $10,000 default threshold
): Promise<{ totalVolume: number; shouldAlert: boolean }> {
  try {
    const db = getFirebaseAdminFirestore();
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const metricsRef = db.collection('payment_metrics');
    const todayMetrics = await metricsRef
      .where('timestamp', '>=', today.toISOString())
      .where('timestamp', '<', tomorrow.toISOString())
      .where('status', '==', 'success')
      .get();

    let totalVolume = 0;
    todayMetrics.docs.forEach((doc: any) => {
      const data = doc.data();
      if (data.amount && data.currency === 'usd') {
        totalVolume += data.amount / 100; // Convert cents to dollars
      }
    });

    const shouldAlert = totalVolume > volumeThreshold;

    if (shouldAlert) {
      await triggerHighVolumeAlert(totalVolume, volumeThreshold);
    }

    return { totalVolume, shouldAlert };
  } catch (error) {
    logger.error('Failed to check payment volume', {
      error: error instanceof Error ? error.message : String(error),
    });
    return { totalVolume: 0, shouldAlert: false };
  }
}

/**
 * Trigger payment failure alert
 */
async function triggerPaymentFailureAlert(
  failureRate: number,
  totalPayments: number,
  failedPayments: number
): Promise<void> {
  try {
    const db = getFirebaseAdminFirestore();
    const alertRef = db.collection('payment_alerts').doc();
    await alertRef.set({
      type: 'payment_failure_rate',
      severity: 'high',
      message: `Payment failure rate is ${failureRate.toFixed(2)}% (${failedPayments}/${totalPayments} payments failed)`,
      data: {
        failureRate,
        totalPayments,
        failedPayments,
      },
      triggeredAt: new Date().toISOString(),
      status: 'active',
    });

    logger.error('PAYMENT FAILURE ALERT TRIGGERED', {
      failureRate,
      totalPayments,
      failedPayments,
    });

    // Here you could integrate with external alerting services like:
    // - Slack webhook
    // - Email service
    // - PagerDuty
    // - Custom notification system
  } catch (error) {
    logger.error('Failed to trigger payment failure alert', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Trigger high volume alert
 */
async function triggerHighVolumeAlert(
  totalVolume: number,
  threshold: number
): Promise<void> {
  try {
    const db = getFirebaseAdminFirestore();
    const alertRef = db.collection('payment_alerts').doc();
    await alertRef.set({
      type: 'high_payment_volume',
      severity: 'medium',
      message: `Daily payment volume exceeded threshold: $${totalVolume.toFixed(2)} (threshold: $${threshold})`,
      data: {
        totalVolume,
        threshold,
      },
      triggeredAt: new Date().toISOString(),
      status: 'active',
    });

    logger.warn('HIGH PAYMENT VOLUME ALERT TRIGGERED', {
      totalVolume,
      threshold,
    });
  } catch (error) {
    logger.error('Failed to trigger high volume alert', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Get payment metrics summary for a time period
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function getPaymentMetricsSummary(
  startDate: Date,
  endDate: Date
): Promise<{
  totalPayments: number;
  successfulPayments: number;
  failedPayments: number;
  totalVolume: number;
  averageAmount: number;
}> {
  try {
    const db = getFirebaseAdminFirestore();
    const metricsRef = db.collection('payment_metrics');
    const metrics = await metricsRef
      .where('timestamp', '>=', startDate.toISOString())
      .where('timestamp', '<=', endDate.toISOString())
      .get();

    let totalPayments = 0;
    let successfulPayments = 0;
    let failedPayments = 0;
    let totalVolume = 0;

    metrics.docs.forEach((doc: any) => {
      const data = doc.data();
      totalPayments++;

      if (data.status === 'success') {
        successfulPayments++;
        if (data.amount && data.currency === 'usd') {
          totalVolume += data.amount / 100; // Convert cents to dollars
        }
      } else if (data.status === 'failed') {
        failedPayments++;
      }
    });

    const averageAmount =
      successfulPayments > 0 ? totalVolume / successfulPayments : 0;

    return {
      totalPayments,
      successfulPayments,
      failedPayments,
      totalVolume,
      averageAmount,
    };
  } catch (error) {
    logger.error('Failed to get payment metrics summary', {
      error: error instanceof Error ? error.message : String(error),
    });
    return {
      totalPayments: 0,
      successfulPayments: 0,
      failedPayments: 0,
      totalVolume: 0,
      averageAmount: 0,
    };
  }
}

/**
 * Clean up old metrics and alerts (call periodically)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function cleanupOldMetrics(
  metricsRetentionDays: number = 90,
  alertsRetentionDays: number = 30
): Promise<void> {
  try {
    const db = getFirebaseAdminFirestore();
    const now = new Date();

    // Clean up old metrics
    const metricsCutoff = new Date(now);
    metricsCutoff.setDate(metricsCutoff.getDate() - metricsRetentionDays);

    const oldMetrics = await db
      .collection('payment_metrics')
      .where('recordedAt', '<', metricsCutoff.toISOString())
      .limit(500)
      .get();

    if (!oldMetrics.empty) {
      const batch = db.batch();
      oldMetrics.docs.forEach((doc: any) => batch.delete(doc.ref));
      await batch.commit();
    }

    // Clean up old alerts
    const alertsCutoff = new Date(now);
    alertsCutoff.setDate(alertsCutoff.getDate() - alertsRetentionDays);

    const oldAlerts = await db
      .collection('payment_alerts')
      .where('triggeredAt', '<', alertsCutoff.toISOString())
      .limit(500)
      .get();

    if (!oldAlerts.empty) {
      const batch = db.batch();
      oldAlerts.docs.forEach((doc: any) => batch.delete(doc.ref));
      await batch.commit();
    }

    logger.info('Payment metrics cleanup completed', {
      deletedMetrics: oldMetrics.size,
      deletedAlerts: oldAlerts.size,
    });
  } catch (error) {
    logger.error('Payment metrics cleanup failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
