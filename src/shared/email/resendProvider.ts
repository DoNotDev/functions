// packages/functions/src/shared/email/resendProvider.ts

/**
 * @fileoverview Resend Email Provider
 * @description Zero-dependency Resend implementation using raw fetch.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import type { EmailProviderAdapter } from './provider.js';

const RESEND_API_URL = 'https://api.resend.com/emails';

/**
 * Create a Resend email provider adapter.
 *
 * @param apiKey - Resend API key
 * @returns EmailProviderAdapter implementation
 *
 * @example
 * ```typescript
 * const provider = createResendProvider(Deno.env.get('RESEND_API_KEY')!);
 * await provider.send({ from: 'noreply@app.com', to: 'user@example.com', subject: 'Hello', html: '<p>Hi</p>' });
 * ```
 */
export function createResendProvider(apiKey: string): EmailProviderAdapter {
  if (!apiKey) {
    throw new Error('Resend API key is required');
  }

  return {
    async send({ from, to, subject, html, replyTo }) {
      const body: Record<string, string> = { from, to, subject, html };
      if (replyTo) body.reply_to = replyTo;

      const response = await fetch(RESEND_API_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'Unknown error');
        throw new Error(`Resend API error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      return { messageId: result.id };
    },
  };
}
