// packages/functions/src/shared/ai/resolveModelTier.ts

/**
 * @fileoverview AI Model Tier Resolver
 * @description Resolves the model ID for a given tier via env var chain.
 * Resolution: per-function env → per-tier env → static SSOT.
 * Cross-runtime: Deno (edge functions) + Node (Vercel/Firebase).
 *
 * @version 0.1.0
 * @since 0.6.0
 * @author AMBROISE PARK Consulting
 */

import { AI_TIERS } from '@donotdev/core/server';
import type { AITierId } from '@donotdev/core/server';

// =============================================================================
// Env helper (Deno + Node cross-runtime)
// =============================================================================

function getEnv(name: string): string | undefined {
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    return (globalThis as any).Deno?.env?.get(name);
  }
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

// =============================================================================
// Resolver
// =============================================================================

/**
 * Resolve the AI model ID for a given tier.
 *
 * Resolution chain (first non-empty wins):
 * 1. `AI_MODEL_<FUNCTION_NAME>` env var (per-function override)
 * 2. `AI_TIER_<TIER>` env var (per-tier override)
 * 3. `AI_TIERS.<TIER>.defaultModel` (static SSOT from constants)
 *
 * @param tier - The tier ID ('fast', 'standard', 'premium')
 * @param functionName - Optional function name for per-function env var lookup
 * @returns The resolved model ID string
 */
export function resolveModelForTier(
  tier: AITierId,
  functionName?: string
): string {
  // 1. Per-function env var: AI_MODEL_BRAINSTORM, AI_MODEL_SPEC_CHAT, etc.
  if (functionName) {
    const perFn = getEnv(`AI_MODEL_${functionName.toUpperCase()}`);
    if (perFn) return perFn;
  }

  // 2. Per-tier env var: AI_TIER_FAST, AI_TIER_STANDARD, AI_TIER_PREMIUM
  const perTier = getEnv(`AI_TIER_${tier.toUpperCase()}`);
  if (perTier) return perTier;

  // 3. Static SSOT
  const tierConfig = Object.values(AI_TIERS).find((t) => t.id === tier);
  return tierConfig?.defaultModel ?? AI_TIERS.STANDARD.defaultModel;
}
