// packages/functions/src/supabase/ai/createAIFunction.ts

/**
 * @fileoverview AI Chat - Supabase Edge Function Factory
 * @description Wraps the shared AI route handler for Supabase Edge Functions.
 * Uses Vercel AI SDK via createAIRoute for streaming and non-streaming.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import type {
  AIChatRequest,
  AICostRecord,
  AIRouteConfig,
} from '@donotdev/core/server';
import { AIChatRequestSchema } from '@donotdev/core/server';

import { handleAIRequest } from '../../shared/ai/index.js';
import { createSupabaseHandler } from '../baseFunction.js';

/**
 * Create a Supabase Edge Function handler for AI chat.
 *
 * @param config - AI route configuration
 * @returns `(req: Request) => Promise<Response>` handler
 *
 * @example
 * ```typescript
 * // supabase/functions/ai-chat/index.ts
 * import { createAIFunction } from '@donotdev/functions/supabase';
 *
 * const handler = createAIFunction({
 *   provider: 'anthropic',
 *   model: 'claude-sonnet-4-20250514',
 *   cost: { markup: 4.0, monthlyBudgetTokens: 500_000, showCostToUsers: false, displayCurrency: 'eur' },
 * });
 * Deno.serve(handler);
 * ```
 */
export function createAIFunction(config: AIRouteConfig) {
  return createSupabaseHandler(
    'ai-chat',
    AIChatRequestSchema,
    async (data: AIChatRequest, ctx) => {
      return handleAIRequest(data, config, {
        userId: ctx.uid,
        requestId: crypto.randomUUID(),
        onCostRecord: async (record: AICostRecord) => {
          // Write cost record to Supabase
          const { error } = await ctx.supabaseAdmin.from('ai_usage').insert({
            user_id: record.userId,
            model: record.model,
            provider: record.provider,
            prompt_tokens: record.usage.promptTokens,
            completion_tokens: record.usage.completionTokens,
            total_tokens: record.usage.totalTokens,
            provider_cost: record.providerCost,
            billed_cost: record.billedCost,
            markup: record.markup,
            request_id: record.requestId,
            created_at: record.timestamp,
          });

          if (error) {
            console.error(
              '[AI] Failed to record cost to Supabase:',
              error.message
            );
          }
        },
      });
    }
  );
}
