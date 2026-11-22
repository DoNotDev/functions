// packages/functions/src/vercel/api/crud/index.ts

/**
 * @fileoverview Vercel API CRUD barrel exports
 * @description Centralized exports for Vercel API CRUD functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// Route handlers are default exports: `export *` would drop them
export { default as bulk } from './bulk.js';
export { default as createEntity } from './create.js';
export { default as deleteEntity } from './delete.js';
export { default as getEntity } from './get.js';
export { default as listEntities } from './list.js';
export { default as updateEntity } from './update.js';
