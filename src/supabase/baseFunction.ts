// packages/functions/src/supabase/baseFunction.ts

/**
 * @fileoverview Base Supabase Edge Function handler
 * @description Handles auth verification, request validation, and error responses
 * for Supabase Edge Functions. Mirrors the Firebase/Vercel base function pattern.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import { createClient } from '@supabase/supabase-js';
import * as v from 'valibot';

import { hasRoleAccess } from '@donotdev/core/server';
import type { UserRole, SecurityContext } from '@donotdev/core/server';

import { recordOperationMetrics } from './utils/monitoring.js';
import {
  checkRateLimitWithPostgres,
  DEFAULT_RATE_LIMITS,
} from './utils/rateLimiter.js';

import type { RateLimitConfig } from './utils/rateLimiter.js';
import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Types
// =============================================================================

/**
 * Context passed to Supabase Edge Function business logic
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export interface SupabaseHandlerContext {
  /** Authenticated user ID (from JWT verification) */
  uid: string;
  /** User role extracted from app_metadata.role */
  userRole: UserRole;
  /** Supabase admin client (service role — full access) */
  supabaseAdmin: SupabaseClient;
}

// =============================================================================
// Base Handler
// =============================================================================

/**
 * Create a Supabase Edge Function handler with built-in auth, validation, role checking, and error handling.
 *
 * @param operationName - Operation name for logging
 * @param schema - Valibot schema for request body validation
 * @param handler - Business logic function
 * @param requiredRole - Minimum role required (default: 'user')
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 *
 * @example
 * ```typescript
 * import * as v from 'valibot';
 * import { createSupabaseHandler } from '@donotdev/functions/supabase';
 *
 * const schema = v.object({ userId: v.string() });
 *
 * export default createSupabaseHandler('delete-account', schema, async (data, ctx) => {
 *   await ctx.supabaseAdmin.auth.admin.deleteUser(data.userId);
 *   return { success: true };
 * }, 'admin');
 * ```
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createSupabaseHandler<TReq, TRes>(
  operationName: string,
  schema: v.BaseSchema<unknown, TReq, v.BaseIssue<unknown>>,
  handler: (data: TReq, context: SupabaseHandlerContext) => Promise<TRes>,
  requiredRole: UserRole = 'user',
  security?: SecurityContext
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    try {
      // CORS preflight
      // C3: CORS origin is configurable via ALLOWED_ORIGIN env var.
      // Default '*' is acceptable for pure-token-auth edge functions where credentials
      // (cookies) are never used. Consumers that need credentialed requests must set
      // ALLOWED_ORIGIN to their specific frontend origin.
      //
      // Architecture decision — CORS wildcard (`*`) as framework default:
      // This is an intentional development-convenience default, not a security oversight.
      // Consumer apps override it by setting the ALLOWED_ORIGIN environment variable
      // (e.g. ALLOWED_ORIGIN=https://myapp.example) in their Supabase Edge Function config.
      // The framework documents this in the deployment guide.
      const allowedOrigin = getEnv('ALLOWED_ORIGIN', '*');
      // Local wrapper so all responses in this closure carry the correct origin
      const respond = (data: unknown, status: number) =>
        jsonResponse(data, status, allowedOrigin);

      if (req.method === 'OPTIONS') {
        return new Response(null, {
          status: 204,
          headers: {
            'Access-Control-Allow-Origin': allowedOrigin,
            'Access-Control-Allow-Methods': 'POST, OPTIONS',
            'Access-Control-Allow-Headers':
              'authorization, content-type, x-client-info, apikey',
          },
        });
      }

      // Method check
      if (req.method !== 'POST') {
        return respond({ error: 'Method not allowed' }, 405);
      }

      // Extract and verify auth token
      const authHeader = req.headers.get('authorization');
      if (!authHeader?.startsWith('Bearer ')) {
        return respond(
          { error: 'Missing or invalid authorization header' },
          401
        );
      }
      const token = authHeader.slice(7);

      // Create admin client
      const supabaseUrl = getEnvOrThrow('SUPABASE_URL');
      // Try new env var first, fall back to legacy name
      const secretKey =
        getEnv('SUPABASE_SECRET_KEY') || getEnv('SUPABASE_SERVICE_ROLE_KEY');
      if (!secretKey) {
        throw new Error(
          'Missing environment variable: SUPABASE_SECRET_KEY or SUPABASE_SERVICE_ROLE_KEY'
        );
      }
      const supabaseAdmin = createClient(supabaseUrl, secretKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      });

      // Verify JWT and extract user
      const {
        data: { user },
        error: authError,
      } = await supabaseAdmin.auth.getUser(token);
      if (authError || !user) {
        return respond({ error: 'Invalid or expired token' }, 401);
      }

      // Extract user role from app_metadata (Supabase stores custom claims here)
      const appMetadata = (user.app_metadata ?? {}) as Record<string, unknown>;
      const userRole: UserRole = (appMetadata.role as UserRole) || 'user';

      // Role-based access control
      if (requiredRole === 'guest') {
        // Guest access: no additional check needed
      } else {
        // Non-guest access: verify user has required role level
        if (!hasRoleAccess(userRole, requiredRole)) {
          return respond(
            {
              error: `Access denied. Required role: ${requiredRole}, your role: ${userRole}`,
            },
            403
          );
        }
      }

      // Rate limiting (on by default, set DISABLE_RATE_LIMITING=true to opt out)
      const disableRateLimiting = getEnv('DISABLE_RATE_LIMITING') === 'true';
      if (!disableRateLimiting) {
        // Use IP-based key for guest operations, UID-based for authenticated
        const rateLimitIdentifier =
          requiredRole === 'guest' && user.id === 'guest'
            ? `ip_${getClientIp(req)}`
            : `uid_${user.id}`;
        const rateLimitKey = `${operationName}_${rateLimitIdentifier}`;
        const rateLimitConfig: RateLimitConfig =
          (DEFAULT_RATE_LIMITS as Record<string, RateLimitConfig>)[
            operationName
          ] || DEFAULT_RATE_LIMITS.api;

        const rateLimitResult = await checkRateLimitWithPostgres(
          supabaseAdmin,
          rateLimitKey,
          rateLimitConfig
        );

        if (!rateLimitResult.allowed) {
          security?.audit({
            type: 'rate_limit.exceeded',
            userId: user.id,
            metadata: { operation: operationName, remaining: 0 },
          });
          return respond(
            {
              error: `Rate limit exceeded. Try again in ${rateLimitResult.blockRemainingSeconds} seconds.`,
            },
            429
          );
        }
      }

      // G64: Reject oversized request bodies before parsing (1MB limit)
      const contentLength = req.headers.get('content-length');
      const MAX_BODY_SIZE = 1_048_576; // 1MB
      if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
        return respond(
          {
            error: `Request body too large. Maximum size: ${MAX_BODY_SIZE} bytes`,
          },
          413
        );
      }

      // Parse and validate request body
      const body = await req.json().catch(() => ({}));
      const validationResult = v.safeParse(schema, body);
      if (!validationResult.success) {
        const issues = validationResult.issues.map((i) => i.message).join(', ');
        return respond({ error: `Validation failed: ${issues}` }, 400);
      }

      // Record metrics (only if enabled via ENABLE_METRICS env var)
      const enableMetrics = getEnv('ENABLE_METRICS') === 'true';
      const startTime = enableMetrics ? Date.now() : 0;

      // Execute business logic
      let result: TRes;
      let error: Error | null = null;
      try {
        result = await handler(validationResult.output, {
          uid: user.id,
          userRole,
          supabaseAdmin,
        });
      } catch (handlerError) {
        error =
          handlerError instanceof Error
            ? handlerError
            : new Error(String(handlerError));
        throw handlerError;
      } finally {
        // Record metrics if enabled
        if (enableMetrics) {
          const durationMs = Date.now() - startTime;
          await recordOperationMetrics(supabaseAdmin, {
            operation: operationName,
            userId: user.id,
            status: error ? 'failed' : 'success',
            durationMs,
            metadata: {
              requestId: req.headers.get('x-request-id') || undefined,
            },
            errorCode: error ? getErrorCode(error.message) : undefined,
            errorMessage: error ? error.message : undefined,
          });
        }
      }

      // Passthrough for streaming responses (e.g., AI SSE streams)
      if (result instanceof Response) {
        const headers = new Headers(result.headers);
        headers.set('Access-Control-Allow-Origin', allowedOrigin);
        return new Response(result.body, {
          status: result.status,
          statusText: result.statusText,
          headers,
        });
      }

      return respond(result, 200);
    } catch (error) {
      console.error(`[${operationName}] Error:`, error);
      const rawMessage =
        error instanceof Error ? error.message : 'Internal server error';
      const errorCode = getErrorCode(rawMessage);
      // Only pass through messages for known safe error codes.
      // All other/unknown errors get a generic message to prevent information leaks.
      const SAFE_ERROR_CODES = new Set([
        'rate-limit-exceeded',
        'not-found',
        'permission-denied',
        'invalid-argument',
        'already-exists',
      ]);
      const message = SAFE_ERROR_CODES.has(errorCode)
        ? rawMessage
        : 'Internal server error';
      const status = getErrorStatus(rawMessage);
      // allowedOrigin may not be set if error occurred before that line; fall back to '*'
      const origin = getEnv('ALLOWED_ORIGIN', '*');
      return jsonResponse({ error: message }, status, origin);
    }
  };
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(
  data: unknown,
  status: number,
  allowedOrigin = '*'
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
    },
  });
}

function getEnvOrThrow(key: string): string {
  const value = (
    typeof Deno !== 'undefined' ? Deno.env.get(key) : process.env[key]
  ) as string | undefined;
  if (!value) throw new Error(`Missing environment variable: ${key}`);
  return value;
}

function getEnv(key: string, defaultValue: string = ''): string {
  return (
    ((typeof Deno !== 'undefined' ? Deno.env.get(key) : process.env[key]) as
      | string
      | undefined) || defaultValue
  );
}

// G65: Basic IP format validation (IPv4 or IPv6 pattern)
const IP_PATTERN = /^(?:\d{1,3}\.){3}\d{1,3}$|^[0-9a-fA-F:]{2,45}$/;

function isValidIp(ip: string): boolean {
  return IP_PATTERN.test(ip);
}

function getClientIp(req: Request): string {
  // Try X-Forwarded-For first (common for proxied requests)
  const forwardedFor = req.headers.get('x-forwarded-for');
  if (forwardedFor) {
    // W19: Take the rightmost (last) IP — the leftmost entry is client-supplied
    // and trivially spoofable. The last entry is appended by the nearest trusted
    // reverse proxy and is the most reliable.
    const ips = forwardedFor
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);
    const lastIp = ips[ips.length - 1];
    // G65: Validate IP format before using it
    if (lastIp && isValidIp(lastIp)) return lastIp;
  }

  // Fallback to CF-Connecting-IP (Cloudflare) or other headers
  const cfIp = req.headers.get('cf-connecting-ip');
  if (cfIp && isValidIp(cfIp)) return cfIp;

  return 'unknown';
}

function getErrorCode(message: string): string {
  if (message.includes('Rate limit')) return 'rate-limit-exceeded';
  if (message.includes('not found') || message.includes('No active'))
    return 'not-found';
  if (
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('Forbidden')
  )
    return 'permission-denied';
  if (
    message.includes('mismatch') ||
    message.includes('Invalid') ||
    message.includes('Missing')
  )
    return 'invalid-argument';
  if (message.includes('already-exists') || message.includes('Duplicate'))
    return 'already-exists';
  return 'internal';
}

function getErrorStatus(message: string): number {
  if (message.includes('Rate limit')) return 429;
  if (message.includes('not found') || message.includes('No active'))
    return 404;
  if (
    message.includes('permission') ||
    message.includes('denied') ||
    message.includes('Forbidden')
  )
    return 403;
  if (
    message.includes('mismatch') ||
    message.includes('Invalid') ||
    message.includes('Missing')
  )
    return 400;
  return 500;
}

// Deno global type declaration for env access
declare const Deno:
  | { env: { get(key: string): string | undefined } }
  | undefined;
