// packages/functions/src/shared/validation.ts

/**
 * @fileoverview Environment validation utilities
 * @description Validate required environment variables on module load
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Validates required environment variables
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function validateEnvironment(): void {
  const requiredEnvVars = [
    'STRIPE_SECRET_KEY',
    'STRIPE_WEBHOOK_SECRET',
    'STRIPE_API_VERSION',
  ] as const;

  const missing: string[] = [];

  for (const envVar of requiredEnvVars) {
    if (!process.env[envVar]) {
      missing.push(envVar);
    }
  }

  if (missing.length > 0) {
    throw new Error(
      `❌ Missing required environment variables:\n${missing.map((v) => `  - ${v}`).join('\n')}\n\n` +
        `Add these to your .env file or environment configuration.`
    );
  }

  // Validate STRIPE_API_VERSION format
  const apiVersion = process.env.STRIPE_API_VERSION!;
  if (!apiVersion.match(/^\d{4}-\d{2}-\d{2}\./)) {
    throw new Error(
      `❌ Invalid STRIPE_API_VERSION format: "${apiVersion}"\n` +
        `Expected format: YYYY-MM-DD.name (e.g., "2025-09-30.clover")`
    );
  }

  // Validate Stripe key format
  const secretKey = process.env.STRIPE_SECRET_KEY!;
  if (!secretKey.startsWith('sk_')) {
    throw new Error(
      `❌ Invalid STRIPE_SECRET_KEY format\n` +
        `Secret keys must start with "sk_" (found: "[redacted]")`
    );
  }

  console.log('✅ Environment validation passed');
}

// IMPORTANT: Do NOT auto-validate on module load
// Firebase CLI loads functions during deployment to discover exports
// Environment variables are not available during deployment
// Validation happens at runtime when functions are called
// validateEnvironment(); // Removed - was breaking Firebase deployment
