// packages/functions/src/supabase/edgeFunction.ts

/**
 * @fileoverview Lightweight edge function wrapper
 * @description Handles CORS, auth, and response formatting for custom Supabase
 * Edge Functions that don't fit the typed createSupabaseHandler pattern.
 *
 * Use createSupabaseHandler for typed CRUD-style handlers with schema validation.
 * Use createEdgeFunction for multi-action functions, AI chat, webhooks, etc.
 *
 * @version 0.1.0
 * @since 0.6.0
 * @author AMBROISE PARK Consulting
 */

import { createClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';

// =============================================================================
// Types
// =============================================================================

/**
 * Context passed to edge function handlers.
 *
 * @version 0.1.0
 * @since 0.6.0
 */
export interface EdgeFunctionContext {
  /** Authenticated user (null if no valid JWT or requireAuth=false) */
  user: { id: string; email?: string } | null;
  /** Admin client (service role, bypasses RLS) - always available */
  supabaseAdmin: SupabaseClient;
  /** User-scoped client (RLS) - null if no valid JWT */
  userClient: SupabaseClient | null;
  /** JSON response with CORS headers */
  json: (data: unknown, status?: number) => Response;
  /** JSON error response: { error: message } with CORS headers */
  error: (message: string, status?: number) => Response;
  /** Raw response with CORS headers (for structured payloads) */
  respond: (data: unknown, status: number) => Response;
}

/** Configuration options for edge function creation. */
export interface EdgeFunctionOptions {
  /** Require JWT auth - returns 401 if missing/invalid (default: true) */
  requireAuth?: boolean;
  /** Extra CORS allowed headers (e.g., 'stripe-signature', 'x-build-secret') */
  extraHeaders?: string[];
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler with CORS, optional auth, and response helpers.
 *
 * @example
 * ```typescript
 * // Auth required (default)
 * Deno.serve(createEdgeFunction(async (req, ctx) => {
 *   const body = await req.json();
 *   return ctx.json({ result: 'ok' });
 * }));
 *
 * // No auth (public endpoint)
 * Deno.serve(createEdgeFunction(async (req, ctx) => {
 *   return ctx.json({ public: true });
 * }, { requireAuth: false }));
 *
 * // Custom auth (webhook)
 * Deno.serve(createEdgeFunction(async (req, ctx) => {
 *   const sig = req.headers.get('stripe-signature');
 *   if (!sig) return ctx.error('Missing signature', 401);
 *   return ctx.json({ received: true });
 * }, { requireAuth: false, extraHeaders: ['stripe-signature'] }));
 * ```
 */
export function createEdgeFunction(
  handler: (req: Request, ctx: EdgeFunctionContext) => Promise<Response>,
  options?: EdgeFunctionOptions
): (req: Request) => Promise<Response> {
  const requireAuth = options?.requireAuth ?? true;
  const baseHeaders = 'authorization, content-type, x-client-info, apikey';
  const allowedHeaders = options?.extraHeaders?.length
    ? `${baseHeaders}, ${options.extraHeaders.join(', ')}`
    : baseHeaders;

  return async (req: Request): Promise<Response> => {
    const allowedOrigin = getEnv('ALLOWED_ORIGIN') || '*';

    // Response helpers (closed over allowedOrigin)
    const respond = (data: unknown, status: number) =>
      jsonResponse(data, status, allowedOrigin);
    const json = (data: unknown, status = 200) => respond(data, status);
    const error = (message: string, status = 400) =>
      respond({ error: message }, status);

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': allowedOrigin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': allowedHeaders,
        },
      });
    }

    // Method check
    if (req.method !== 'POST') {
      return error('Method not allowed', 405);
    }

    // Supabase clients
    const supabaseUrl = getEnv('SUPABASE_URL');
    const serviceKey =
      getEnv('SUPABASE_SECRET_KEY') || getEnv('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !serviceKey) {
      console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
      return error('Server misconfigured', 500);
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // Auth
    let user: { id: string; email?: string } | null = null;
    let userClient: SupabaseClient | null = null;

    const authHeader = req.headers.get('authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const jwt = authHeader.slice(7);
      const anonKey = getEnv('SUPABASE_ANON_KEY');
      if (anonKey) {
        userClient = createClient(supabaseUrl, anonKey, {
          global: { headers: { Authorization: `Bearer ${jwt}` } },
        });
        const { data, error: authError } =
          await supabaseAdmin.auth.getUser(jwt);
        if (!authError && data.user) {
          user = { id: data.user.id, email: data.user.email ?? undefined };
        }
      }
    }

    if (requireAuth && !user) {
      return error('Unauthorized', 401);
    }

    const ctx: EdgeFunctionContext = {
      user,
      supabaseAdmin,
      userClient,
      json,
      error,
      respond,
    };

    try {
      return await handler(req, ctx);
    } catch (e) {
      console.error('Edge function error:', e);
      return error('Internal error', 500);
    }
  };
}

// =============================================================================
// Helpers
// =============================================================================

function jsonResponse(
  data: unknown,
  status: number,
  allowedOrigin: string
): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': allowedOrigin,
    },
  });
}

function getEnv(key: string): string {
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    return (globalThis as any).Deno?.env?.get(key) ?? '';
  }
  return typeof process !== 'undefined' ? (process.env[key] ?? '') : '';
}
