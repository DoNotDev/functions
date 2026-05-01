// packages/functions/src/vercel/api/config/constants.ts

/**
 * @fileoverview Firebase Functions configuration constants
 * @description DRY configuration for regions, timeouts, and other function settings
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Firebase Functions regions
 * Default to eu-west1 for European users (France)
 * Override with FIREBASE_REGION environment variable
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const FIREBASE_REGION = process.env.FIREBASE_REGION || 'europe-west1';

/**
 * Common function configuration options
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const FUNCTION_CONFIG = {
  // Default region for all functions
  region: FIREBASE_REGION,

  // Memory and timeout defaults
  memory: '1GiB' as const,
  timeoutSeconds: 60,
} as const;

/**
 * Stripe-specific configuration
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const STRIPE_CONFIG = {
  region: FIREBASE_REGION,
  memory: '512MiB' as const,
  timeoutSeconds: 30,
} as const;

/**
 * Auth-specific configuration
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const AUTH_CONFIG = {
  region: FIREBASE_REGION,
  memory: '256MiB' as const,
  timeoutSeconds: 20,
} as const;

/**
 * Generic CRUD configuration
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const CRUD_CONFIG = {
  region: FIREBASE_REGION,
  memory: '256MiB' as const,
  timeoutSeconds: 15,
} as const;

/**
 * Available Firebase regions for reference
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const AVAILABLE_REGIONS = {
  // Europe (recommended for France)
  'europe-west1': 'Belgium',
  'europe-west2': 'London',
  'europe-west3': 'Frankfurt',
  'europe-west6': 'Zurich',
  'europe-central2': 'Warsaw',

  // US
  'us-central1': 'Iowa',
  'us-east1': 'South Carolina',
  'us-east4': 'Northern Virginia',
  'us-west1': 'Oregon',

  // Asia
  'asia-east1': 'Taiwan',
  'asia-northeast1': 'Tokyo',
  'asia-southeast1': 'Singapore',
} as const;

/**
 * Environment validation
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const validateEnvironment = () => {
  const required = ['STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET'];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(', ')}`
    );
  }

  console.log(
    `🌍 Firebase Functions configured for region: ${FIREBASE_REGION}`
  );
};

/**
 * Type for Firebase region keys
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export type FirebaseRegion = keyof typeof AVAILABLE_REGIONS;
