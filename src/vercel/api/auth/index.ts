// packages/functions/src/vercel/api/auth/index.ts

/**
 * @fileoverview Vercel API auth barrel exports
 * @description Centralized exports for Vercel API authentication functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// Route handlers are default exports: `export *` would drop them
export { default as getCustomClaims } from './get-custom-claims.js';
export { default as getUserAuthStatus } from './get-user-auth-status.js';
export { default as removeCustomClaims } from './remove-custom-claims.js';
export * from './set-custom-claims.js';
