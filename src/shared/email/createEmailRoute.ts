// packages/functions/src/shared/email/createEmailRoute.ts

/**
 * @fileoverview Email Route Handler
 * @description Platform-agnostic handler for email send requests.
 * Validates request, resolves template, renders with locale, sends via provider.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import type {
  EmailRouteConfig,
  SendEmailRequest,
  SendEmailResponse,
} from '@donotdev/core/server';
import { validateSendEmailRequest } from '@donotdev/core/server';

import type { EmailProviderAdapter } from './provider.js';

/**
 * Handle an email send request.
 * Validates input, resolves the template from the registry, renders with locale, and sends.
 *
 * @param request - Email send request (templateId, to, data, locale)
 * @param config - Email route configuration (provider, templates, defaultFrom)
 * @param provider - Email provider adapter (Resend, etc.)
 * @returns Send result with success status and messageId
 *
 * @example
 * ```typescript
 * const result = await handleEmailRequest(
 *   { templateId: 'order-confirmation', to: 'user@example.com', data: { orderId: '123' }, locale: 'fr' },
 *   emailConfig,
 *   resendProvider
 * );
 * ```
 */
export async function handleEmailRequest(
  request: SendEmailRequest,
  config: EmailRouteConfig,
  provider: EmailProviderAdapter
): Promise<SendEmailResponse> {
  // Validate request
  const validation = validateSendEmailRequest(request);
  if (!validation.success) {
    return {
      success: false,
      error: `Invalid email request: ${validation.issues?.map((i) => i.message).join(', ')}`,
    };
  }

  // Resolve template
  const template = config.templates[request.templateId];
  if (!template) {
    return {
      success: false,
      error: `Template not found: ${request.templateId}`,
    };
  }

  // Render template with locale
  const locale = request.locale || 'fr';
  const subject = template.subject(request.data as any, locale);
  const html = template.html(request.data as any, locale);

  // Send via provider
  const result = await provider.send({
    from: request.from || config.defaultFrom,
    to: request.to,
    subject,
    html,
    replyTo: request.replyTo || config.replyTo,
  });

  return {
    success: true,
    messageId: result.messageId,
  };
}
