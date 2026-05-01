// packages/functions/src/firebase/index.d.ts

/**
 * @fileoverview Firebase Functions
 * @description Barrel exports for Firebase Cloud Functions. Provides centralized access to all Firebase function modules.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

/**
 * Authentication functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './auth/index.js';

/**
 * Billing and payment functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './billing/index.js';

/**
 * Configuration functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './config/index.js';

/**
 * CRUD operation functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './crud/index.js';

/**
 * Helper utility functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './helpers/index.js';

/**
 * OAuth authentication functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './oauth/index.js';

/**
 * Scheduled task functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export * from './scheduled/index.js';

/**
 * Base function factory for creating Firebase functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export { createBaseFunction } from './baseFunction.js';
