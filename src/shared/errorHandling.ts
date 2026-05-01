// packages/functions/src/shared/errorHandling.ts

/**
 * @fileoverview Shared Error Handling
 * @description Platform-agnostic error classification. Always throws DoNotDevError.
 * Platform adapters (Firebase baseFunction, Vercel route handler) catch and convert.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { EntityHookError } from '@donotdev/core/server';
import { DoNotDevError } from '@donotdev/core/server';

// Re-export DoNotDevError so existing imports from this module continue to work
export { DoNotDevError };

/**
 * Classify and throw a DoNotDevError from any unknown error.
 * Pure classification — no platform imports, no env detection.
 *
 * @param error - The error to handle
 * @throws DoNotDevError always
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function handleError(error: unknown): never {
  // W11: Log only in development to avoid double-logging with platform loggers.
  // Known DoNotDevError, ValiError, and EntityHookError are handled by callers.
  if (
    process.env.NODE_ENV === 'development' &&
    !(error instanceof DoNotDevError) &&
    !(error instanceof Error && error.name === 'ValiError') &&
    !(error instanceof Error && error.name === 'EntityHookError')
  ) {
    console.error('Function error:', error);
  }

  // Error classification logic (same for all platforms)
  let code: string;
  let message: string;
  let details: any;

  if (error instanceof DoNotDevError) {
    code = error.code as string;
    message = error.message;
    details = error.details;
  } else if (
    error &&
    typeof error === 'object' &&
    'issues' in error &&
    ((error instanceof Error && error.name === 'ValiError') ||
      (error as any).name === 'ValiError')
  ) {
    code = 'invalid-argument';
    message = 'Validation failed';
    details = { validationErrors: (error as any).issues };
  } else if (
    error &&
    typeof error === 'object' &&
    'type' in error &&
    ((error instanceof Error && error.name === 'EntityHookError') ||
      (error as any).name === 'EntityHookError')
  ) {
    const entityError = error as EntityHookError;
    switch (entityError.type) {
      case 'PERMISSION_DENIED':
        code = 'permission-denied';
        break;
      case 'NOT_FOUND':
        code = 'not-found';
        break;
      case 'ALREADY_EXISTS':
        code = 'already-exists';
        break;
      case 'VALIDATION_ERROR':
        code = 'invalid-argument';
        break;
      case 'NETWORK_ERROR':
        code = 'unavailable';
        break;
      default:
        code = 'internal';
    }
    message = entityError.message;
    details = undefined;
  } else {
    code = 'internal';
    // W10: Never expose error.message for internal errors — it may leak
    // internal file paths, SQL queries, or implementation details to clients.
    // Log server-side only; clients always get the generic message.
    message = 'An unexpected error occurred';
    details = undefined;
  }

  // For internal errors, always use the generic message regardless of source.
  // Other error codes may carry safe, developer-authored messages.
  if (code === 'internal') {
    message = 'An unexpected error occurred';
  }

  throw new DoNotDevError(
    message,
    code as any,
    details ? { details } : undefined
  );
}
