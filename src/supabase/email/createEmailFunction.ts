// packages/functions/src/supabase/email/createEmailFunction.ts

/**
 * @fileoverview Email Send - Supabase Edge Function Factory
 * @description Wraps the shared email handler for Supabase Edge Functions.
 * Resolves Resend provider from env, adds auth context.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import type { EmailRouteConfig, SendEmailRequest } from '@donotdev/core/server';
import { SendEmailRequestSchema } from '@donotdev/core/server';

import { handleEmailRequest } from '../../shared/email/index.js';
import { createResendProvider } from '../../shared/email/resendProvider.js';
import { createSupabaseHandler } from '../baseFunction.js';

/**
 * Create a Supabase Edge Function handler for sending emails.
 * Requires RESEND_API_KEY environment variable.
 *
 * @param config - Email route configuration (templates, defaultFrom)
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/send-email/index.ts
 * import { createEmailFunction } from '@donotdev/functions/supabase';
 *
 * const handler = createEmailFunction({
 *   provider: 'resend',
 *   defaultFrom: 'Frabled <noreply@frabled.com>',
 *   templates: { 'order-confirmation': orderConfirmationTemplate },
 * });
 * Deno.serve(handler);
 * ```
 */
export function createEmailFunction(config: EmailRouteConfig) {
  return createSupabaseHandler(
    'send-email',
    SendEmailRequestSchema,
    async (data: SendEmailRequest, _ctx) => {
      const apiKey = getEnv('RESEND_API_KEY');
      if (!apiKey) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'Email provider not configured',
          }),
          { status: 500, headers: { 'Content-Type': 'application/json' } }
        );
      }

      const provider = createResendProvider(apiKey);
      const result = await handleEmailRequest(data, config, provider);

      return new Response(JSON.stringify(result), {
        status: result.success ? 200 : 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  );
}

function getEnv(name: string): string | undefined {
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    return (globalThis as any).Deno?.env?.get(name);
  }
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}
