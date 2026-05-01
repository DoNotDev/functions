// packages/functions/src/shared/utils/internal/validation.ts

/**
 * @fileoverview Validation utility functions
 * @description Functions for validating environment and data
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { DoNotDevError } from '@donotdev/core/server';

/**
 * Validates environment variables required for Stripe
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateStripeEnvironment(): void {
  const required = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }
}

/**
 * Safely parses JSON with error handling
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function safeJsonParse<T = any>(json: string): T | null {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/**
 * Validates a Firestore collection name from client-supplied schema.
 *
 * W22: Vercel CRUD handlers accept `schema` (including collection name) from
 * the client. This is a known design limitation. As a defense-in-depth measure,
 * reject collection names that could be used for path traversal or access to
 * internal collections.
 *
 * @param name - Collection name to validate
 * @throws Error if the name is unsafe
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateCollectionName(name: string): void {
  if (!name || typeof name !== 'string') {
    throw new Error('Collection name is required');
  }
  if (name.includes('/') || name.includes('..') || name.startsWith('_')) {
    throw new Error(
      'Invalid collection name: must not contain "/", "..", or start with "_"'
    );
  }
}

/**
 * Validates document data against an optional Valibot schema.
 *
 * W1: Previous stub ignored the schema parameter entirely. Now performs
 * actual schema validation when a schema is provided.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateDocument(data: any, schema?: any): void {
  // G63: Throw DoNotDevError instead of plain Error for consistent error handling
  if (!data || typeof data !== 'object') {
    throw new DoNotDevError('Invalid document data', 'invalid-argument');
  }

  if (Array.isArray(data)) {
    throw new DoNotDevError(
      'Document data cannot be an array',
      'invalid-argument'
    );
  }

  // W1: Perform schema validation when a Valibot schema is supplied.
  if (schema) {
    const result = v.safeParse(schema, data);
    if (!result.success) {
      const messages = result.issues
        .map(
          (issue) =>
            `${issue.path?.map((p: { key: string }) => p.key).join('.') || 'root'}: ${issue.message}`
        )
        .join('; ');
      throw new DoNotDevError(
        `Validation failed: ${messages}`,
        'invalid-argument',
        { details: { validationErrors: result.issues } }
      );
    }
  }
}
