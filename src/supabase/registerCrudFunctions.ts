// packages/functions/src/supabase/registerCrudFunctions.ts

/**
 * @fileoverview Auto-register CRUD handlers from entities for Supabase Edge Functions
 * @description Utility to automatically generate CRUD Edge Function handlers for all entities
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import { createSchemas, getListCardFieldNames } from '@donotdev/core/server';
import type { Entity } from '@donotdev/core/server';

import {
  createSupabaseGetEntity,
  createSupabaseCreateEntity,
  createSupabaseUpdateEntity,
  createSupabaseDeleteEntity,
  createSupabaseListEntities,
  createSupabaseAggregateEntities,
  createSupabaseBulkEntity,
} from './crud/index.js';
import { createEdgeFunction } from './edgeFunction.js';

type SupabaseHandler = (req: Request) => Promise<Response>;

interface CrudHandlers {
  handlers: Record<string, SupabaseHandler>;
  serve: (req: Request) => Promise<Response>;
}

/**
 * Create CRUD handlers for all entities (Supabase Edge Functions)
 * Returns handlers object + serve dispatcher function
 *
 * @param entities - Object of { key: Entity } (from `import * as entities from 'entities'`)
 * @returns Object with handlers and serve dispatcher
 *
 * @example
 * ```typescript
 * import * as entities from '../_shared/entities.ts';
 * import { createSupabaseCrudFunctions } from '@donotdev/functions/supabase';
 *
 * const { serve } = createSupabaseCrudFunctions(entities);
 * Deno.serve(serve);
 * ```
 */
export function createSupabaseCrudFunctions(
  entities: Record<string, Entity | unknown>
): CrudHandlers {
  const handlers: Record<string, SupabaseHandler> = {};

  for (const [key, value] of Object.entries(entities)) {
    if (!isEntity(value)) continue;

    const entity = value as Entity;
    const col = entity.collection;
    const schemas = createSchemas(entity);
    const access = entity.access;

    handlers[`create_${col}`] = createSupabaseCreateEntity(
      col,
      schemas.create,
      schemas.draft,
      access.create
    );
    handlers[`get_${col}`] = createSupabaseGetEntity(
      col,
      schemas.get,
      access.read,
      entity.ownership
    );
    handlers[`list_${col}`] = createSupabaseListEntities(
      col,
      schemas.get,
      access.read,
      entity.listFields,
      entity.ownership,
      false
    );
    handlers[`listCard_${col}`] = createSupabaseListEntities(
      col,
      schemas.get,
      access.read,
      getListCardFieldNames(entity),
      entity.ownership,
      true
    );
    handlers[`update_${col}`] = createSupabaseUpdateEntity(
      col,
      schemas.update,
      access.update
    );

    // Extract reference metadata from entity if available
    const schemaWithMeta = schemas.get as {
      metadata?: {
        references?: {
          outgoing?: Array<{
            field: string;
            targetCollection: string;
            required?: boolean;
          }>;
          incoming?: Array<{
            sourceCollection: string;
            sourceField: string;
            required?: boolean;
          }>;
        };
      };
    };
    const referenceMetadata = schemaWithMeta.metadata?.references;

    handlers[`delete_${col}`] = createSupabaseDeleteEntity(
      col,
      access.delete,
      referenceMetadata
    );
    handlers[`aggregate_${col}`] = createSupabaseAggregateEntities(
      col,
      schemas.get,
      access.read
    );
    handlers[`bulk_${col}`] = createSupabaseBulkEntity(
      col,
      schemas.create,
      schemas.draft,
      schemas.update,
      access
    );
  }

  /**
   * Serve dispatcher: CORS via createEdgeFunction, then routes by _functionName.
   * Auth is NOT checked here (requireAuth: false) — individual handlers
   * use createSupabaseHandler which enforces auth + RBAC per operation.
   */
  const serve = createEdgeFunction(
    async (req, ctx) => {
      const body = await req.json().catch(() => ({}));
      const functionName = (body as Record<string, unknown>)
        ._functionName as string;

      if (!functionName) {
        return ctx.error('Missing _functionName in request body', 400);
      }

      const handler = handlers[functionName];
      if (!handler) {
        return ctx.error(`Unknown function: ${functionName}`, 404);
      }

      // Remove _functionName from body before passing to handler
      const { _functionName, ...handlerData } = body as Record<string, unknown>;

      // Create new request with cleaned body
      const handlerReq = new Request(req.url, {
        method: req.method,
        headers: req.headers,
        body: JSON.stringify(handlerData),
      });

      return handler(handlerReq);
    },
    { requireAuth: false }
  );

  return { handlers, serve };
}

/**
 * Type guard to check if a value is an Entity
 */
function isEntity(value: unknown): value is Entity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'collection' in value &&
    'fields' in value
  );
}
