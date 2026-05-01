// packages/functions/src/shared/utils/internal/idempotency.ts

/**
 * @fileoverview Idempotency utilities for functions
 * @description Provides idempotency checking and storage for function calls
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';

import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

/** Stored result of a previously processed idempotent operation. */
export interface IdempotencyResult<T = any> {
  result: T;
  processedAt: string;
  processedBy: string;
}

/**
 * Check if an operation has already been processed (idempotency check)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function checkIdempotency<T = any>(
  key: string,
  operation: string
): Promise<T | null> {
  const db = getFirebaseAdminFirestore();
  try {
    const idempotencyRef = db
      .collection('idempotency')
      .doc(`${operation}_${key}`);
    const idempotencyDoc = await idempotencyRef.get();

    if (idempotencyDoc.exists) {
      const data = idempotencyDoc.data() as IdempotencyResult<T>;
      logger.info('Operation already processed (idempotency)', {
        key,
        operation,
        processedAt: data.processedAt,
        processedBy: data.processedBy,
      });
      return data.result;
    }

    return null;
  } catch (error) {
    logger.error('Idempotency check failed', {
      key,
      operation,
      error: error instanceof Error ? error.message : String(error),
    });
    // Fail closed — duplicate processing is worse than a transient failure
    throw new Error(
      `Idempotency check failed for ${operation}/${key}: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

/**
 * Store the result of an operation for idempotency
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export async function storeIdempotencyResult<T = any>(
  key: string,
  operation: string,
  result: T,
  processedBy: string
): Promise<void> {
  try {
    const db = getFirebaseAdminFirestore();
    const idempotencyRef = db
      .collection('idempotency')
      .doc(`${operation}_${key}`);
    await idempotencyRef.set({
      result,
      processedAt: new Date().toISOString(),
      processedBy,
    });

    logger.info('Idempotency result stored', {
      key,
      operation,
      processedBy,
    });
  } catch (error) {
    logger.error('Failed to store idempotency result', {
      key,
      operation,
      processedBy,
      error: error instanceof Error ? error.message : String(error),
    });
    // Don't throw - idempotency storage failure shouldn't break the operation
  }
}
