// packages/functions/src/shared/crud/index.ts

/**
 * @fileoverview Shared CRUD orchestration primitives.
 * @description Barrel for the target-agnostic CRUD cores that Firestore,
 *   Supabase, Vercel, GraphQL and REST-CRUD server aids all consume.
 *   Exported from `@donotdev/functions/shared` (and the root entry) so
 *   out-of-package consumers can build their own adapters without pulling
 *   a target-specific SDK.
 *
 * @version 0.1.0
 * @since 0.7.0
 * @author AMBROISE PARK Consulting
 */

export {
  executeBulk,
  type ExecuteBulkParams,
  type PreparedBulk,
  type PreparedInsert,
  type PreparedUpdate,
  type BulkRowSchema,
} from './bulkCore.js';
