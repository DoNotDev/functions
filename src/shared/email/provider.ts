// packages/functions/src/shared/email/provider.ts

/**
 * @fileoverview Email Provider Adapter Interface
 * @description Abstract interface for email sending. Providers implement this.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

/**
 * Email provider adapter interface.
 * Each provider (Resend, SES, etc.) implements this single method.
 */
export interface EmailProviderAdapter {
  /**
   * Send an email via the provider.
   *
   * @param params - Email parameters
   * @returns Provider message ID for tracking
   * @throws On provider error (network, auth, etc.)
   */
  send(params: {
    from: string;
    to: string;
    subject: string;
    html: string;
    replyTo?: string;
  }): Promise<{ messageId: string }>;
}
