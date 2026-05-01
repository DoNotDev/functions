// packages/functions/src/supabase/crud/index.ts

/**
 * @fileoverview Supabase CRUD handlers barrel export
 * @description Exports all Supabase CRUD handler factories
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

export { createSupabaseGetEntity } from './get.js';
export { createSupabaseCreateEntity } from './create.js';
export { createSupabaseUpdateEntity } from './update.js';
export { createSupabaseDeleteEntity } from './delete.js';
export { createSupabaseListEntities } from './list.js';
export { createSupabaseAggregateEntities } from './aggregate.js';
export { createSupabaseBulkEntity } from './bulk.js';

export type { GetEntityRequest } from './get.js';
export type { CreateEntityRequest } from './create.js';
export type { UpdateEntityRequest } from './update.js';
export type { DeleteEntityRequest, ReferenceMetadata } from './delete.js';
export type { ListEntityRequest } from './list.js';
export type { AggregateEntityRequest } from './aggregate.js';
export type { BulkEntityRequest } from './bulk.js';
