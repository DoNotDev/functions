// packages/functions/src/vercel/api/oauth/index.ts

/**
 * @fileoverview Vercel API OAuth barrel exports
 * @description Centralized exports for Vercel API OAuth functions
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

// Route handlers and factories are default exports: `export *` would drop them
export { default as checkGitHubAccess } from './check-github-access.js';
export { default as exchangeToken } from './exchange-token.js';
export { default as grantGitHubAccess } from './grant-github-access.js';
export { default as revokeGitHubAccess } from './revoke-github-access.js';
