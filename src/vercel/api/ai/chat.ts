// packages/functions/src/vercel/api/ai/chat.ts

/**
 * @fileoverview AI Chat - Vercel Route Handler
 * @description Next.js App Router route handler for AI chat.
 * Uses Vercel AI SDK via shared handleAIRequest.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import type { AIRouteConfig } from '@donotdev/core/server';
import { AIChatRequestSchema } from '@donotdev/core/server';
import * as v from 'valibot';

import { handleAIRequest } from '../../../shared/ai/index.js';
import { verifyToken } from '../../../shared/utils/internal/auth.js';

/**
 * Create a Next.js App Router POST handler for AI chat.
 *
 * @param config - AI route configuration
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // app/api/ai/chat/route.ts
 * import { createAIChatRoute } from '@donotdev/functions/vercel';
 *
 * export const POST = createAIChatRoute({
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-20250514',
 *   cost: { markup: 4.0, monthlyBudgetTokens: 0, showCostToUsers: false, displayCurrency: 'eur' },
 * });
 * ```
 */
export function createAIChatRoute(config: AIRouteConfig) {
  return async (req: Request): Promise<Response> => {
    // Auth
    const authHeader = req.headers.get('authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return new Response(
        JSON.stringify({ error: 'Missing authorization header' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    const token = authHeader.slice(7);
    let uid: string;
    try {
      const decoded = await verifyToken(token);
      uid = decoded.uid;
    } catch {
      return new Response(
        JSON.stringify({ error: 'Invalid or expired token' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Parse + validate body
    const body = await req.json().catch(() => ({}));
    const validation = v.safeParse(AIChatRequestSchema, body);
    if (!validation.success) {
      const issues = validation.issues.map((i) => i.message).join(', ');
      return new Response(
        JSON.stringify({ error: `Validation failed: ${issues}` }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return handleAIRequest(validation.output, config, {
      userId: uid,
      requestId: crypto.randomUUID(),
    });
  };
}
