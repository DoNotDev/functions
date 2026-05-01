// packages/functions/src/firebase/index.ts

/**
 * @fileoverview Firebase functions barrel exports
 * @description Centralized exports for Firebase function implementations
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

export * from './auth/index.js';
export * from './billing/index.js';
export * from './config/index.js';
export * from './crud/index.js';
export * from './helpers/index.js';
export * from './oauth/index.js';
export * from './scheduled/index.js';

// Base function for creating Firebase functions
export { createBaseFunction } from './baseFunction.js';

// CRUD function registration utility
export {
  registerCrudFunctions,
  createCrudFunctions,
  type CrudFunctions,
} from './registerCrudFunctions.js';
