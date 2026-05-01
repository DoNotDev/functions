// packages/functions/src/shared/index.ts

/**
 * @fileoverview Shared utilities barrel exports
 * @description Centralized exports for shared function utilities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

export * from './errorHandling.js';
export * from './github.js';
export * from './metadata.js';
export * from './schema.js';
export * from './utils/index.js';
export * from './crud/index.js';
export * from './ai/index.js';
export * from './billing/index.js';
export * from './email/index.js';
export * from './oauth/index.js';
export {
  createTimestamp,
  toTimestamp,
  isTimestamp,
  transformFirestoreData,
  prepareForFirestore,
} from './firebase.js';
// Note: toISOString is exported from ./utils/external/date.js (handles DateValue).
// The Firebase-specific toISOString (FirestoreTimestamp only) is available via direct import from ./firebase.js.
