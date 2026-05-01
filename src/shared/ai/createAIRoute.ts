// packages/functions/src/shared/ai/createAIRoute.ts

/**
 * @fileoverview AI Route Handler (Vercel AI SDK)
 * @description Platform-agnostic handler for AI chat requests using Vercel AI SDK.
 * Handles auth (via platform wrapper), rate limiting (Upstash), streaming, and cost tracking.
 *
 * @version 0.1.0
 * @since 0.1.0
 * @author AMBROISE PARK Consulting
 */

import { streamText, generateText, tool, jsonSchema } from 'ai';
import type { LanguageModel, CoreTool } from 'ai';

import type {
  AIChatRequest,
  AICostConfig,
  AICostRecord,
  AIRateLimitConfig,
  AIRouteConfig,
  AIToolDefinition,
  AIUsage,
} from '@donotdev/core/server';
import { AI_MODELS, validateAIChatRequest } from '@donotdev/core/server';

import { calculateCost } from './costTracker.js';

// =============================================================================
// Types
// =============================================================================

/** Per-request options passed to the AI route handler. */
export interface AIRouteOptions {
  /** Authenticated user ID */
  userId: string;
  /** Request ID for cost tracking */
  requestId?: string;
  /** Callback to persist cost record (platform-specific) */
  onCostRecord?: (record: AICostRecord) => Promise<void>;
}

/** Provider factory map - lazily creates provider instances */
type ProviderFactory = (apiKey: string) => LanguageModel;

// =============================================================================
// Provider Resolution
// =============================================================================

/** Lazily import and create provider models */
async function resolveModel(
  provider: string,
  model: string
): Promise<LanguageModel> {
  const factories: Record<string, () => Promise<ProviderFactory>> = {
    anthropic: async () => {
      const { createAnthropic } = await import('@ai-sdk/anthropic');
      return (apiKey: string) => createAnthropic({ apiKey })(model);
    },
    openai: async () => {
      const { createOpenAI } = await import('@ai-sdk/openai');
      return (apiKey: string) => createOpenAI({ apiKey })(model);
    },
    google: async () => {
      const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
      return (apiKey: string) => createGoogleGenerativeAI({ apiKey })(model);
    },
  };

  const factory = factories[provider];
  if (!factory) {
    throw new Error(`Unsupported AI provider: ${provider}`);
  }

  const apiKey = getAIApiKey(provider);
  const createModel = await factory();
  return createModel(apiKey);
}

// =============================================================================
// Rate Limiting (reused from old handler)
// =============================================================================

const DEFAULT_RATE_LIMIT: AIRateLimitConfig = {
  maxRequests: 30,
  windowMs: 60_000,
};

let rateLimiter: {
  check: (userId: string, config: AIRateLimitConfig) => Promise<void>;
} | null = null;

async function getRateLimiter() {
  if (rateLimiter) return rateLimiter;

  const redisUrl = getEnv('UPSTASH_REDIS_REST_URL');
  const redisToken = getEnv('UPSTASH_REDIS_REST_TOKEN');

  if (!redisUrl || !redisToken) {
    console.warn(
      '[AI] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN not set. Rate limiting disabled.'
    );
    rateLimiter = { check: async () => {} };
    return rateLimiter;
  }

  try {
    const { Ratelimit } = await import('@upstash/ratelimit');
    const { Redis } = await import('@upstash/redis');

    const redis = new Redis({ url: redisUrl, token: redisToken });
    const limiters = new Map<string, InstanceType<typeof Ratelimit>>();

    rateLimiter = {
      check: async (userId: string, config: AIRateLimitConfig) => {
        const key = `${config.maxRequests}:${config.windowMs}`;
        let rl = limiters.get(key);
        if (!rl) {
          rl = new Ratelimit({
            redis,
            limiter: Ratelimit.slidingWindow(
              config.maxRequests,
              `${config.windowMs}ms`
            ),
            prefix: 'ai_rl',
          });
          limiters.set(key, rl);
        }

        const result = await rl.limit(userId);
        if (!result.success) {
          throw new Error(
            `Rate limit exceeded. Maximum ${config.maxRequests} requests per ${config.windowMs / 1000}s.`
          );
        }
      },
    };
    return rateLimiter;
  } catch (err) {
    console.warn(
      '[AI] Failed to initialize Upstash rate limiter:',
      err instanceof Error ? err.message : err
    );
    rateLimiter = { check: async () => {} };
    return rateLimiter;
  }
}

// =============================================================================
// Tool Conversion (JSON Schema → Vercel AI SDK tool)
// =============================================================================

/**
 * Convert framework tool definitions to Vercel AI SDK tools.
 * Uses `jsonSchema()` from the AI SDK to pass JSON Schema directly (no zod dependency).
 * Merges request-level tools with config-level tools (request takes precedence).
 */
function resolveTools(
  requestTools?: Record<string, AIToolDefinition>,
  configTools?: Record<string, AIToolDefinition>
): Record<string, CoreTool> | undefined {
  const merged = { ...configTools, ...requestTools };
  if (Object.keys(merged).length === 0) return undefined;

  const sdkTools: Record<string, CoreTool> = {};
  for (const [name, def] of Object.entries(merged)) {
    sdkTools[name] = tool({
      description: def.description,
      parameters: jsonSchema(def.parameters),
    });
  }
  return sdkTools;
}

// =============================================================================
// Core Handler
// =============================================================================

/**
 * Handle an AI chat request using Vercel AI SDK.
 * Supports both streaming (returns SSE Response) and non-streaming (returns JSON).
 *
 * @param request - Validated AI chat request
 * @param config - Route configuration
 * @param options - Per-request options (userId, cost callback)
 * @returns Response (SSE stream or JSON)
 */
export async function handleAIRequest(
  request: AIChatRequest,
  config: AIRouteConfig,
  options: AIRouteOptions
): Promise<Response> {
  // Validate request
  const validation = validateAIChatRequest(request);
  if (!validation.success) {
    return jsonError(
      `Invalid AI request: ${validation.issues?.map((i) => i.message).join(', ')}`,
      400
    );
  }

  // Resolve provider + model
  const provider = request.provider || config.provider || 'anthropic';
  const providerModels = AI_MODELS[provider as keyof typeof AI_MODELS];
  const model =
    request.model ||
    config.model ||
    providerModels?.default ||
    'claude-sonnet-4-20250514';

  // Validate model against allowed list
  if (providerModels) {
    const allowed = providerModels.models as readonly string[];
    if (!allowed.includes(model)) {
      return jsonError(
        `Model '${model}' is not allowed for provider '${provider}'. Allowed: ${allowed.join(', ')}`,
        400
      );
    }
  }

  // Rate limit
  try {
    const rl = await getRateLimiter();
    await rl.check(
      options.userId,
      config.rateLimitConfig || DEFAULT_RATE_LIMIT
    );
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : 'Rate limit exceeded',
      429
    );
  }

  // Resolve AI SDK model
  let languageModel: LanguageModel;
  try {
    languageModel = await resolveModel(provider, model);
  } catch (err) {
    return jsonError(
      `Failed to initialize provider: ${err instanceof Error ? err.message : String(err)}`,
      500
    );
  }

  // Build messages for AI SDK
  const systemMessages = request.messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content);
  const systemPrompt =
    request.systemPrompt ||
    config.systemPrompt ||
    (systemMessages.length > 0 ? systemMessages.join('\n') : undefined);

  const messages = request.messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role as 'user' | 'assistant',
      content: m.content,
    }));

  const maxTokens = request.maxTokens || config.maxTokens || 4096;
  const temperature = request.temperature ?? config.temperature ?? 0.7;
  const requestId = options.requestId || crypto.randomUUID();

  // Resolve tools (request-level overrides config-level)
  const tools = resolveTools(request.tools, config.tools);

  // Cost tracking helper
  const recordCost = async (usage: AIUsage) => {
    if (!options.onCostRecord) return;

    const markup = config.cost?.markup ?? 4.0;
    const cost = calculateCost(usage, model, markup);

    const record: AICostRecord = {
      userId: options.userId,
      model,
      provider,
      usage,
      providerCost: cost.providerCost,
      billedCost: cost.billedCost,
      markup,
      timestamp: new Date().toISOString(),
      requestId,
    };

    // Non-blocking - don't let cost recording failure break the response
    options.onCostRecord(record).catch((err) => {
      console.error('[AI] Failed to record cost:', err);
    });
  };

  // Streaming vs non-streaming
  if (request.stream !== false) {
    // Streaming (default)
    const result = streamText({
      model: languageModel,
      messages,
      system: systemPrompt,
      maxTokens,
      temperature,
      tools,
      onFinish: async ({ usage }: { usage: any }) => {
        await recordCost({
          promptTokens: usage.promptTokens,
          completionTokens: usage.completionTokens,
          totalTokens: usage.promptTokens + usage.completionTokens,
        });
      },
    });

    return result.toDataStreamResponse();
  }

  // Non-streaming
  const result = await generateText({
    model: languageModel,
    messages,
    system: systemPrompt,
    maxTokens,
    temperature,
    tools,
  });

  const usage: AIUsage = {
    promptTokens: result.usage.promptTokens,
    completionTokens: result.usage.completionTokens,
    totalTokens: result.usage.promptTokens + result.usage.completionTokens,
  };

  await recordCost(usage);

  // Extract tool calls from result
  const toolCalls =
    result.toolCalls?.map((tc: any) => ({
      id: tc.toolCallId,
      name: tc.toolName,
      args: tc.args,
    })) ?? [];

  return new Response(
    JSON.stringify({
      message: {
        role: 'assistant',
        content: result.text,
      },
      usage,
      finishReason: result.finishReason,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      model,
      provider,
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }
  );
}

// =============================================================================
// Helpers
// =============================================================================

function jsonError(message: string, status: number): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function getEnv(name: string): string | undefined {
  if (typeof globalThis !== 'undefined' && 'Deno' in globalThis) {
    return (globalThis as any).Deno?.env?.get(name);
  }
  return typeof process !== 'undefined' ? process.env[name] : undefined;
}

function getAIApiKey(provider: string): string {
  const providerKeyMap: Record<string, string> = {
    anthropic: 'ANTHROPIC_API_KEY',
    openai: 'OPENAI_API_KEY',
    google: 'GOOGLE_AI_API_KEY',
  };

  const providerKey = providerKeyMap[provider];
  if (providerKey) {
    const key = getEnv(providerKey);
    if (key) return key;
  }

  const key = getEnv('AI_API_KEY');
  if (!key) {
    throw new Error(
      `Missing API key. Set ${providerKey || 'AI_API_KEY'} environment variable.`
    );
  }
  return key;
}
