// packages/functions/src/firebase/baseFunction.ts

/**
 * @fileoverview Base Firebase function that handles all common concerns
 * @description Rate limiting, monitoring, authentication, validation - all in one place
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import * as v from 'valibot';

import type { SecurityContext } from '@donotdev/core';
import { hasRoleAccess } from '@donotdev/core/server';
import type { UserRole } from '@donotdev/core/server';

import { FUNCTION_CONFIG } from './config/constants.js';
import { handleError, DoNotDevError } from '../shared/errorHandling.js';
import { assertAuthenticated, getUserRole } from '../shared/utils.js';

import type {
  CallableRequest,
  CallableOptions,
} from 'firebase-functions/v2/https';

// Optional monitoring imports - only used when enabled
// Lazy loaded to avoid unnecessary Firestore operations
let checkRateLimitWithFirestore:
  | typeof import('../shared/utils/internal/rateLimiter.js').checkRateLimitWithFirestore
  | null = null;
let DEFAULT_RATE_LIMITS:
  | typeof import('../shared/utils/internal/rateLimiter.js').DEFAULT_RATE_LIMITS
  | null = null;
let recordPaymentMetrics:
  | typeof import('../shared/utils/internal/monitoring.js').recordPaymentMetrics
  | null = null;

async function loadRateLimiter() {
  if (!checkRateLimitWithFirestore) {
    const mod = await import('../shared/utils/internal/rateLimiter.js');
    checkRateLimitWithFirestore = mod.checkRateLimitWithFirestore;
    DEFAULT_RATE_LIMITS = mod.DEFAULT_RATE_LIMITS;
  }
  return { checkRateLimitWithFirestore, DEFAULT_RATE_LIMITS };
}

async function loadMonitoring() {
  if (!recordPaymentMetrics) {
    const mod = await import('../shared/utils/internal/monitoring.js');
    recordPaymentMetrics = mod.recordPaymentMetrics;
  }
  return recordPaymentMetrics;
}

/**
 * Extract client IP from Firebase callable request.
 *
 * **Architecture decision — X-Forwarded-For rightmost IP extraction:**
 *
 * C6/W12: X-Forwarded-For is a comma-separated list where each proxy appends
 * the IP it received the request from. The leftmost entry is client-supplied
 * and trivially spoofable. The rightmost entry is appended by the first
 * trusted reverse proxy and is the last untrusted IP.
 *
 * In Firebase Hosting / Cloud Run, the last proxy is Google's load balancer
 * which sets X-Forwarded-For. The rightmost (last) IP is the true external
 * client IP in this trusted-infrastructure context. This is correct for the
 * single-proxy-depth that Google's LB provides.
 *
 * Consumers deploying behind additional reverse proxies (e.g. Cloudflare in
 * front of Firebase) should configure `trustedProxyDepth` so the framework
 * skips the appropriate number of rightmost entries.
 *
 * Rate-limiting falls back to the socket IP if the header is absent.
 */
function getClientIp(request: CallableRequest<unknown>): string {
  const forwardedFor = request.rawRequest.headers['x-forwarded-for'];
  if (forwardedFor) {
    const raw = Array.isArray(forwardedFor)
      ? forwardedFor.join(',')
      : forwardedFor;
    // Split and take the RIGHTMOST entry (last untrusted / first-to-be-trusted)
    const ips = raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    if (ips.length > 0) {
      return ips[ips.length - 1]!;
    }
  }

  // Fallback to raw socket IP (not proxied)
  const rawIp =
    request.rawRequest.ip || request.rawRequest.socket?.remoteAddress;
  return rawIp || 'unknown';
}

/**
 * Base Firebase function that handles all common concerns
 * Users just provide their business logic
 *
 * Rate limiting and metrics are enabled by default.
 * Set `DISABLE_RATE_LIMITING=true` or `DISABLE_METRICS=true` to opt out.
 *
 * @param config - Firebase function config (region, memory, etc.)
 * @param schema - Valibot schema for request validation
 * @param operation - Operation name for logging/metrics
 * @param businessLogic - The actual business logic to execute
 * @param requiredRole - Minimum role required (default: 'user' for backwards compatibility)
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function createBaseFunction<TRequest, TResponse>(
  // W16: Typed as CallableOptions instead of `any`.
  config: CallableOptions,
  schema: v.BaseSchema<unknown, TRequest, v.BaseIssue<unknown>>,
  operation: string,
  businessLogic: (
    data: TRequest,
    context: {
      uid: string;
      userRole: UserRole;
      request: CallableRequest<TRequest>;
    }
  ) => Promise<TResponse>,
  requiredRole: UserRole = 'user',
  security?: SecurityContext
) {
  // Validate schema at function creation time (framework-level robustness)
  if (!schema) {
    const error = new Error(
      `Schema is undefined for ${operation}. Ensure the schema is properly imported and exported.`
    );
    logger.error(
      `[createBaseFunction] Schema validation failed at creation time`,
      {
        operation,
        schemaType: typeof schema,
        schemaValue: schema,
        schemaConstructor: (schema as any)?.constructor?.name,
      }
    );
    throw error;
  }

  // Validate schema is a valid Valibot schema
  if (typeof schema !== 'object' || schema === null) {
    const error = new Error(
      `Invalid schema type for ${operation}. Expected Valibot schema object, got ${typeof schema}.`
    );
    logger.error(`[createBaseFunction] Invalid schema type`, {
      operation,
      schemaType: typeof schema,
      schemaValue: schema,
    });
    throw error;
  }

  return onCall<TRequest>(
    config,
    async (request: CallableRequest<TRequest>) => {
      try {
        // Log incoming request for debugging
        logger.info(`[${operation}] Request received`, {
          hasAuth: !!request.auth,
          userId: request.auth?.uid || 'anonymous',
          hasData: request.data !== undefined && request.data !== null,
          dataKeys: request.data ? Object.keys(request.data) : [],
          // G73: Wrap in try-catch to avoid broken mid-JSON output on circular refs
          dataPreview: (() => {
            if (!request.data) return 'null';
            try {
              const json = JSON.stringify(request.data);
              return json.length > 200 ? json.substring(0, 200) + '...' : json;
            } catch {
              return '[unserializable]';
            }
          })(),
        });

        // App Check monitoring (logs missing tokens for visibility)
        // Actual enforcement is via enforceAppCheck in config
        if (!request.app) {
          logger.warn(`[AppCheck] Missing token for ${operation}`, {
            hasAuth: !!request.auth,
            userId: request.auth?.uid || 'anonymous',
          });
        }

        // Schema should already be validated at function creation time
        // This is a defensive check in case schema becomes undefined at runtime (shouldn't happen)
        if (!schema) {
          logger.error(
            `[${operation}] Schema became undefined at runtime (this should not happen)`,
            {
              operation,
              schemaType: typeof schema,
              requestData: request.data,
            }
          );
          throw new Error(
            `Schema is undefined for ${operation} - this indicates a bundling/import issue`
          );
        }

        // Normalize undefined/null to empty object for validation
        // This allows callable functions with no parameters to work correctly
        const requestData = request.data ?? {};

        let validatedData: TRequest;
        try {
          validatedData = v.parse(schema, requestData);
        } catch (parseError) {
          logger.error(`Schema validation failed for ${operation}`, {
            error:
              parseError instanceof Error
                ? parseError.message
                : String(parseError),
            data: request.data,
          });
          throw parseError;
        }

        // Get user role from auth context
        const userRole = getUserRole(request.auth);
        let uid: string;

        // Role-based access control
        if (requiredRole === 'guest') {
          // Guest access: no authentication required
          // Use 'guest' as UID for unauthenticated users
          uid = request.auth?.uid || 'guest';
        } else {
          // Non-guest access: require authentication
          uid = assertAuthenticated(request.auth);

          // Verify user has required role level
          if (!hasRoleAccess(userRole, requiredRole)) {
            logger.warn(`Insufficient role for ${operation}`, {
              userId: uid,
              userRole,
              requiredRole,
            });
            throw new Error(
              `Access denied. Required role: ${requiredRole}, your role: ${userRole}`
            );
          }
        }

        // Rate limiting (on by default, set DISABLE_RATE_LIMITING=true to opt out)
        if (process.env.DISABLE_RATE_LIMITING !== 'true') {
          const {
            checkRateLimitWithFirestore: checkLimit,
            DEFAULT_RATE_LIMITS: limits,
          } = await loadRateLimiter();

          // Use IP-based key for guest operations, UID-based for authenticated
          const rateLimitIdentifier =
            requiredRole === 'guest' && uid === 'guest'
              ? `ip_${getClientIp(request)}`
              : `uid_${uid}`;
          const rateLimitKey = `${operation}_${rateLimitIdentifier}`;
          // G52: Guard against prototype pollution — only allow own properties on limits
          const rateLimitConfig = Object.hasOwn(limits!, operation)
            ? limits![operation as keyof typeof limits]
            : limits!.api;
          const rateLimitResult = await checkLimit!(
            rateLimitKey,
            rateLimitConfig
          );

          if (!rateLimitResult.allowed) {
            logger.warn(`Rate limit exceeded for ${operation}`, {
              identifier: rateLimitIdentifier,
              remaining: rateLimitResult.remaining,
              resetAt: rateLimitResult.resetAt,
            });
            security?.audit({
              type: 'rate_limit.exceeded',
              userId: uid,
              metadata: { operation, remaining: 0 },
            });
            throw new Error(
              `Rate limit exceeded. Try again in ${rateLimitResult.blockRemainingSeconds} seconds.`
            );
          }
        }

        // Call user's business logic
        const result = await businessLogic(validatedData, {
          uid,
          userRole,
          request,
        });

        // Record metrics (only if enabled via ENABLE_METRICS env var)
        if (process.env.ENABLE_METRICS === 'true') {
          const recordMetrics = await loadMonitoring();
          await recordMetrics!({
            operation,
            userId: uid,
            status: 'success',
            timestamp: new Date().toISOString(),
            metadata: {
              requestId:
                request.rawRequest.headers['x-request-id'] || 'unknown',
            },
          });
        }

        return result;
      } catch (error) {
        // Record error metrics (only if enabled)
        if (process.env.ENABLE_METRICS === 'true') {
          const recordMetrics = await loadMonitoring();
          await recordMetrics!({
            operation,
            userId: request.auth?.uid || 'anonymous',
            status: 'failed' as const,
            timestamp: new Date().toISOString(),
            metadata: {
              error: error instanceof Error ? error.message : 'Unknown error',
              requestId:
                request.rawRequest.headers['x-request-id'] || 'unknown',
            },
          });
        }

        try {
          handleError(error);
        } catch (classified) {
          if (classified instanceof DoNotDevError) {
            const { HttpsError } = await import('firebase-functions/v2/https');
            throw new HttpsError(
              classified.code as any,
              classified.message,
              classified.details
            );
          }
          throw classified;
        }
      }
    }
  );
}
