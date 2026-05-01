// packages/functions/src/shared/ai/classifyAIError.ts

/**
 * @fileoverview AI Error Classifier
 * @description Classifies Anthropic API errors into actionable categories
 * for structured error responses in edge functions.
 *
 * @version 0.1.0
 * @since 0.6.0
 * @author AMBROISE PARK Consulting
 */

// =============================================================================
// Types
// =============================================================================

/** Actionable error category for AI provider failures. */
export type AIErrorCode =
  | 'rate_limited'
  | 'overloaded'
  | 'auth_error'
  | 'credits_exhausted'
  | 'network'
  | 'internal';

/** Result of classifying an AI provider error with retry and severity metadata. */
export interface ClassifiedAIError {
  code: AIErrorCode;
  retryable: boolean;
  retryAfterMs?: number;
  severity: 'transient' | 'critical';
}

// =============================================================================
// Classifier
// =============================================================================

/**
 * Classify an error from an Anthropic API call into an actionable category.
 *
 * | HTTP/Error       | Category           | Retryable | Severity   |
 * |------------------|--------------------|-----------|------------|
 * | 429              | rate_limited       | yes       | transient  |
 * | 529 / 503        | overloaded         | yes       | transient  |
 * | 401              | auth_error         | no        | critical   |
 * | 402 / credits    | credits_exhausted  | no        | critical   |
 * | Network/timeout  | network            | yes       | transient  |
 * | Other 5xx        | internal           | no        | critical   |
 */
export function classifyAIError(err: unknown): ClassifiedAIError {
  const status = extractStatus(err);
  const message = extractMessage(err);

  // 429 - Rate limited
  if (status === 429) {
    return {
      code: 'rate_limited',
      retryable: true,
      retryAfterMs: extractRetryAfter(err) ?? 5_000,
      severity: 'transient',
    };
  }

  // 529 / 503 - Overloaded
  if (status === 529 || status === 503) {
    return {
      code: 'overloaded',
      retryable: true,
      retryAfterMs: extractRetryAfter(err) ?? 10_000,
      severity: 'transient',
    };
  }

  // 401 - Auth error
  if (status === 401) {
    return { code: 'auth_error', retryable: false, severity: 'critical' };
  }

  // 402 or insufficient credits
  if (
    status === 402 ||
    message.includes('insufficient') ||
    message.includes('credit')
  ) {
    return {
      code: 'credits_exhausted',
      retryable: false,
      severity: 'critical',
    };
  }

  // Network / timeout errors (no HTTP status)
  if (
    !status &&
    (message.includes('fetch') ||
      message.includes('network') ||
      message.includes('ECONNREFUSED') ||
      message.includes('ETIMEDOUT') ||
      message.includes('timeout') ||
      message.includes('aborted') ||
      err instanceof TypeError)
  ) {
    return {
      code: 'network',
      retryable: true,
      retryAfterMs: 3_000,
      severity: 'transient',
    };
  }

  // Everything else
  return { code: 'internal', retryable: false, severity: 'critical' };
}

/**
 * Map a classified error code to an HTTP status for the edge function response.
 */
export function mapClassifiedToHTTP(code: AIErrorCode): number {
  switch (code) {
    case 'rate_limited':
      return 429;
    case 'overloaded':
      return 503;
    case 'auth_error':
      return 502;
    case 'credits_exhausted':
      return 502;
    case 'network':
      return 502;
    case 'internal':
      return 500;
  }
}

// =============================================================================
// Helpers
// =============================================================================

function extractStatus(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    // Anthropic SDK errors have .status
    if ('status' in err && typeof (err as any).status === 'number') {
      return (err as any).status;
    }
    // Some errors nest status in .error
    if ('error' in err && typeof (err as any).error?.status === 'number') {
      return (err as any).error.status;
    }
  }
  return undefined;
}

function extractMessage(err: unknown): string {
  if (err instanceof Error) return err.message.toLowerCase();
  if (typeof err === 'string') return err.toLowerCase();
  if (err && typeof err === 'object' && 'message' in err) {
    return String((err as any).message).toLowerCase();
  }
  return '';
}

function extractRetryAfter(err: unknown): number | undefined {
  if (err && typeof err === 'object') {
    // Anthropic SDK puts headers on the error
    const headers = (err as any).headers;
    if (headers) {
      const retryAfter =
        typeof headers.get === 'function'
          ? headers.get('retry-after')
          : headers['retry-after'];
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!Number.isNaN(seconds)) return seconds * 1000;
      }
    }
  }
  return undefined;
}
