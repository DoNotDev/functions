// packages/functions/src/shared/utils/validation.ts

/**
 * @fileoverview Enhanced validation utilities
 * @description Comprehensive validation functions for Stripe operations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import * as v from 'valibot';

/**
 * Validation schemas for Stripe operations
 */
export const StripeValidationSchemas = {
  webhookEvent: v.object({
    id: v.pipe(v.string(), v.minLength(1, 'Event ID is required')),
    type: v.pipe(v.string(), v.minLength(1, 'Event type is required')),
    data: v.object({
      object: v.any(),
    }),
    created: v.pipe(v.number(), v.minValue(0, 'Valid timestamp required')),
  }),

  purchaseRequest: v.object({
    userId: v.pipe(v.string(), v.minLength(1, 'User ID is required')),
    productType: v.pipe(v.string(), v.minLength(1, 'Product type is required')),
    githubUsername: v.optional(
      v.pipe(
        v.string(),
        v.regex(
          /^[a-zA-Z0-9]([a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/,
          'Invalid GitHub username'
        )
      )
    ),
    sessionId: v.pipe(v.string(), v.minLength(1, 'Session ID is required')),
    amount: v.optional(
      v.pipe(v.number(), v.minValue(0, 'Amount must be positive'))
    ),
    currency: v.optional(
      v.pipe(v.string(), v.length(3, 'Currency must be 3 characters'))
    ),
  }),
};

/**
 * Validation result interface
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export interface ValidationResult {
  isValid: boolean;
  errors: string[];
  data?: any;
}

/**
 * Validate webhook event
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateWebhookEvent(data: any): ValidationResult {
  try {
    const validatedData = v.parse(StripeValidationSchemas.webhookEvent, data);
    return {
      isValid: true,
      data: validatedData,
      errors: [],
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'issues' in error &&
      ((error instanceof Error && error.name === 'ValiError') ||
        (error as any).name === 'ValiError')
    ) {
      const valiError = error as any;
      const errors = valiError.issues.map(
        (err: v.BaseIssue<unknown>) =>
          `${err.path?.map((p) => p.key).join('.') || ''}: ${err.message}`
      );
      logger.warn('Webhook event validation failed', { errors, data });
      return {
        isValid: false,
        errors,
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error'],
    };
  }
}

/**
 * Validate purchase request
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validatePurchaseRequest(data: any): ValidationResult {
  try {
    const validatedData = v.parse(
      StripeValidationSchemas.purchaseRequest,
      data
    );
    return {
      isValid: true,
      data: validatedData,
      errors: [],
    };
  } catch (error) {
    if (
      error &&
      typeof error === 'object' &&
      'issues' in error &&
      ((error instanceof Error && error.name === 'ValiError') ||
        (error as any).name === 'ValiError')
    ) {
      const valiError = error as any;
      const errors = valiError.issues.map(
        (err: v.BaseIssue<unknown>) =>
          `${err.path?.map((p) => p.key).join('.') || ''}: ${err.message}`
      );
      logger.warn('Purchase request validation failed', { errors, data });
      return {
        isValid: false,
        errors,
      };
    }
    return {
      isValid: false,
      errors: ['Unknown validation error'],
    };
  }
}

/**
 * Validate GitHub username format
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateGitHubUsername(username: string): boolean {
  const githubUsernameRegex =
    /^[a-zA-Z0-9]([a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;
  return githubUsernameRegex.test(username);
}

/**
 * Validate email format
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

/**
 * Validate price ID format (Stripe price IDs start with 'price_')
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateStripePriceId(priceId: string): boolean {
  return priceId.startsWith('price_') && priceId.length > 6;
}

/**
 * Validate session ID format (Stripe session IDs start with 'cs_')
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateStripeSessionId(sessionId: string): boolean {
  return sessionId.startsWith('cs_') && sessionId.length > 3;
}

/**
 * Validate URL format
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateUrl(url: string, name: string = 'URL'): string {
  try {
    const parsedUrl = new URL(url);

    if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
      throw new Error(`Invalid protocol: ${parsedUrl.protocol}`);
    }

    return url;
  } catch (error) {
    throw new Error(
      `Invalid ${name}: ${url}. ${error instanceof Error ? error.message : 'Invalid URL format'}`
    );
  }
}

/**
 * Validate and sanitize metadata object
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateMetadata(
  metadata: Record<string, any>
): Record<string, string> {
  const sanitized: Record<string, string> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (typeof value !== 'string') {
      throw new Error(
        `Metadata value for key '${key}' must be a string, got ${typeof value}`
      );
    }

    const sanitizedValue = value
      .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
      .replace(/javascript:/gi, '')
      .replace(/on\w+\s*=/gi, '');

    if (sanitizedValue.length > 1000) {
      throw new Error(
        `Metadata value for key '${key}' is too long (max 1000 characters)`
      );
    }

    if (key.length > 100) {
      throw new Error(`Metadata key '${key}' is too long (max 100 characters)`);
    }

    sanitized[key] = sanitizedValue;
  }

  return sanitized;
}
