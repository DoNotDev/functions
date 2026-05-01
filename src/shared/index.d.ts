// packages/functions/src/shared/index.d.ts

/**
 * @fileoverview Shared Functions Utilities
 * @description Barrel exports for shared utilities used across Firebase and Vercel functions. Provides centralized access to common function utilities.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Error handling utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './errorHandling.js';

/**
 * GitHub integration utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './github.js';

/**
 * Metadata utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './metadata.js';

/**
 * Schema validation utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './schema.js';

/**
 * General utility functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './utils/index.js';

/**
 * Shared CRUD orchestration core (executeBulk, ExecuteBulkParams, ...).
 *
 * @version 0.1.0
 * @since 0.7.0
 * @author AMBROISE PARK Consulting
 */
export * from './crud/index.js';

/**
 * Billing utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './billing/index.js';

/**
 * OAuth utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './oauth/index.js';

/**
 * Firebase timestamp and data transformation utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export {
  createTimestamp,
  toTimestamp,
  toISOString,
  isTimestamp,
  transformFirestoreData,
  prepareForFirestore,
} from './firebase.js';
