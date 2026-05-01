// packages/functions/src/shared/ai/costTracker.ts

/**
 * @fileoverview Server-Side Cost Calculator
 * @description Calculate per-request AI costs using SSOT pricing from `@donotdev/core`.
 * Cost records are written async by platform wrappers (Supabase, Vercel, Firebase).
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import type { AICostResult, AIUsage } from '@donotdev/core/server';
import { AI_TOKEN_PRICING, DEFAULT_AI_MARKUP } from '@donotdev/core/server';

/**
 * Calculate cost from token usage for a given model.
 *
 * @param usage - Token usage counts
 * @param model - Model ID (must exist in AI_TOKEN_PRICING)
 * @param markup - Markup multiplier (default: 4.0)
 * @returns Cost breakdown with provider and billed amounts
 * @throws Error if model is not in pricing table
 */
export function calculateCost(
  usage: AIUsage,
  model: string,
  markup: number = DEFAULT_AI_MARKUP
): AICostResult {
  const pricing = AI_TOKEN_PRICING[model];
  if (!pricing) {
    throw new Error(`Unknown model for cost calculation: ${model}`);
  }

  const promptCost = (usage.promptTokens / 1_000_000) * pricing.promptPer1M;
  const completionCost =
    (usage.completionTokens / 1_000_000) * pricing.completionPer1M;
  const providerCost = promptCost + completionCost;

  return {
    providerCost,
    billedCost: providerCost * markup,
    markup,
    breakdown: {
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      promptCost,
      completionCost,
    },
  };
}
