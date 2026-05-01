// packages/functions/src/firebase/config/constants.ts

/**
 * @fileoverview Firebase Functions configuration constants
 * @description DRY configuration for regions, timeouts, and other function settings
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/** Default region - override with FIREBASE_REGION env var */
export const FIREBASE_REGION = process.env.FIREBASE_REGION || 'europe-west1';

/** Enable App Check enforcement - set ENFORCE_APP_CHECK=true to enable */
const ENFORCE_APP_CHECK = process.env.ENFORCE_APP_CHECK === 'true';

/** Base config inherited by all function configs */
const BASE_CONFIG = {
  region: FIREBASE_REGION,
  ...(ENFORCE_APP_CHECK && { enforceAppCheck: true }),
} as const;

/** Default function config */
export const FUNCTION_CONFIG = {
  ...BASE_CONFIG,
  invoker: 'public', // Cloud Run allows HTTP, onCall validates Firebase Auth
  memory: '1GiB' as const,
  timeoutSeconds: 60,
  cors: true, // Enable CORS by default for all functions (required for web apps)
} as const;

/** Stripe/billing functions */
export const STRIPE_CONFIG = {
  ...BASE_CONFIG,
  memory: '512MiB' as const,
  timeoutSeconds: 30,
  cors: true,
};

/** Auth functions */
export const AUTH_CONFIG = {
  ...BASE_CONFIG,
  memory: '256MiB' as const,
  timeoutSeconds: 20,
} as const;

/** CRUD functions - all use public invoker (security enforced via role-based access in code) */
export const CRUD_CONFIG = {
  ...BASE_CONFIG,
  invoker: 'public', // Cloud Run allows HTTP, onCall validates Firebase Auth + role-based access
  memory: '256MiB' as const,
  timeoutSeconds: 15,
  cors: true, // Enable CORS for cross-origin requests (required for web apps)
} as const;

/** CRUD read functions (get, list) - can be public for guest access */
export const CRUD_READ_CONFIG = {
  ...BASE_CONFIG,
  invoker: 'public', // Cloud Run allows HTTP, onCall validates Firebase Auth
  memory: '256MiB' as const,
  timeoutSeconds: 15,
  cors: true, // Enable CORS for cross-origin requests (required for web apps)
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
