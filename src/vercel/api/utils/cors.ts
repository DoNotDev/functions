// packages/functions/src/vercel/api/utils/cors.ts

/**
 * @fileoverview CORS utilities for Vercel API
 * @description CORS configuration and handling for Vercel functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * CORS configuration for Vercel functions.
 *
 * **Architecture decision — CORS wildcard (`*`) as framework default:**
 * The wildcard origin is an intentional development-convenience default, not a
 * security oversight. Consumer apps MUST override `allowedOrigins` in their
 * deployment configuration for production environments. The framework provides
 * `configureCors({ allowedOrigins: ['https://myapp.example'] })` for this purpose.
 *
 * C2: Allow-Credentials:true is incompatible with wildcard origin per the Fetch spec.
 * Credentialed requests require an explicit origin. Removed Allow-Credentials header so
 * the wildcard origin remains valid. Consumers that need credentialed cross-origin requests
 * must replace '*' with their specific origin and re-add Allow-Credentials:true.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const corsHeaders = {
  // Framework default — consumers override via configureCors({ allowedOrigins }) in production
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Authorization, X-Requested-With',
  'Access-Control-Max-Age': '86400',
};

/**
 * Handle CORS preflight requests
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function handleCors(req: NextApiRequest, res: NextApiResponse): boolean {
  // Set CORS headers for all responses
  Object.entries(corsHeaders).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  // Warn if wildcard origin is used in production — consumers should override
  const origin = corsHeaders['Access-Control-Allow-Origin'];
  if (process.env.NODE_ENV === 'production' && origin === '*') {
    console.warn(
      '[DoNotDev] CORS origin is set to wildcard (*) in production. Override in your cors config.'
    );
  }

  // Handle preflight OPTIONS request
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true; // Indicates that the request was handled
  }

  return false; // Indicates that the request should continue processing
}

/**
 * Wrapper for Vercel API functions to automatically handle CORS
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function withCors(
  handler: (req: NextApiRequest, res: NextApiResponse) => Promise<void>
) {
  return async (req: NextApiRequest, res: NextApiResponse) => {
    // Handle CORS preflight
    if (handleCors(req, res)) {
      return; // Preflight handled, no need to continue
    }

    // Call the actual handler
    await handler(req, res);
  };
}
