// packages/functions/src/vercel/baseFunction.ts

/**
 * @fileoverview Base Vercel function that handles all common concerns
 * @description Rate limiting, monitoring, authentication, validation - all in one place
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { SecurityContext } from '@donotdev/core';

import { handleError, DoNotDevError } from '../shared/errorHandling.js';
import { verifyAuthToken } from '../shared/utils/internal/auth.js';
import { recordPaymentMetrics } from '../shared/utils/internal/monitoring.js';
import {
  checkRateLimitWithFirestore,
  DEFAULT_RATE_LIMITS,
} from '../shared/utils/internal/rateLimiter.js';

import type { AuthProvider } from '../shared/utils/internal/auth.js';
import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Base Vercel function that handles all common concerns
 * Users just provide their business logic
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createVercelBaseFunction<TRequest, TResponse>(
  method: string,
  schema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  operation: string,
  businessLogic: (
    req: NextApiRequest,
    res: NextApiResponse,
    data: TRequest,
    context: {
      uid: string;
    }
  ) => Promise<TResponse>,
  security?: SecurityContext,
  /** Auth provider for token verification. Auto-detects via provider registry if omitted. */
  provider?: AuthProvider
) {
  return async (
    req: NextApiRequest,
    res: NextApiResponse
  ): Promise<TResponse> => {
    try {
      // Method validation
      if (req.method !== method) {
        return res
          .status(405)
          .json({ error: 'Method not allowed' }) as TResponse;
      }

      // Validate with schema - this handles ALL validation
      const validationResult = v.safeParse(schema, req.body);
      if (!validationResult.success) {
        return res.status(400).json({
          error: `Validation failed: ${validationResult.issues.map((e) => e.message).join(', ')}`,
        }) as TResponse;
      }

      const validatedData = validationResult.output;

      // Verify authentication — extracts Bearer token and verifies via configured provider
      const uid = await verifyAuthToken(req, provider);

      // Rate limiting
      const rateLimitKey = `${operation}_${uid}`;
      const rateLimitConfig =
        (DEFAULT_RATE_LIMITS as any)[operation] || DEFAULT_RATE_LIMITS.api;
      const rateLimitResult = await checkRateLimitWithFirestore(
        rateLimitKey,
        rateLimitConfig
      );

      if (!rateLimitResult.allowed) {
        security?.audit({
          type: 'rate_limit.exceeded',
          userId: uid,
          metadata: { operation, remaining: 0 },
        });
        return res.status(429).json({
          error: `Rate limit exceeded. Try again in ${rateLimitResult.blockRemainingSeconds} seconds.`,
          retryAfter: rateLimitResult.blockRemainingSeconds,
        }) as TResponse;
      }

      // Call user's business logic
      const result = await businessLogic(req, res, validatedData, { uid });

      // G72: Warn if businessLogic returned undefined/null — may indicate a missing return
      if (result === undefined || result === null) {
        console.warn(
          `[${operation}] businessLogic returned ${result} — ensure the handler returns a value or calls res.json() directly`
        );
      }

      // W3: Only record metrics when explicitly enabled — avoids unconditional
      // Firestore writes on every request.
      if (process.env.ENABLE_METRICS === 'true') {
        await recordPaymentMetrics({
          operation,
          userId: uid,
          status: 'success',
          timestamp: new Date().toISOString(),
          metadata: {
            requestId: (req.headers['x-request-id'] as string) || 'unknown',
          },
        });
      }

      return result;
    } catch (error) {
      // W3: Only record error metrics when enabled.
      if (process.env.ENABLE_METRICS === 'true') {
        await recordPaymentMetrics({
          operation,
          userId: req.headers.authorization ? 'authenticated' : 'anonymous',
          status: 'failed' as const,
          timestamp: new Date().toISOString(),
          metadata: {
            error: error instanceof Error ? error.message : 'Unknown error',
            requestId: (req.headers['x-request-id'] as string) || 'unknown',
          },
        });
      }

      // Classify error via shared handler, then map to HTTP response
      try {
        handleError(error);
      } catch (classified) {
        const errorResponse = classifiedToHttp(classified);
        return res
          .status(errorResponse.status)
          .json({ error: errorResponse.message }) as TResponse;
      }

      // Unreachable — handleError always throws. Fallback for TypeScript.
      return res
        .status(500)
        .json({ error: 'Internal server error' }) as TResponse;
    }
  };
}

/** Map a DoNotDevError code to an HTTP status + message */
function classifiedToHttp(error: unknown): {
  status: number;
  message: string;
} {
  if (error instanceof DoNotDevError) {
    const STATUS_MAP: Record<string, number> = {
      'invalid-argument': 400,
      'validation-failed': 400,
      unauthenticated: 401,
      'permission-denied': 403,
      'not-found': 404,
      'already-exists': 409,
      'rate-limit-exceeded': 429,
      'deadline-exceeded': 504,
      unavailable: 503,
    };
    const status = STATUS_MAP[error.code] ?? 500;
    return { status, message: error.message };
  }

  return { status: 500, message: 'Internal server error' };
}
