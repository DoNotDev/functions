// packages/functions/src/supabase/crud/delete.ts

/**
 * @fileoverview Generic handler to delete an entity from Supabase.
 * @description Provides a reusable implementation for deleting documents from PostgreSQL.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { UserRole } from '@donotdev/core/server';

import { DoNotDevError } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';

/** Request payload for deleting a single entity by ID. */
export type DeleteEntityRequest = { id: string };

/**
 * Reference metadata for entity deletion checking
 */
export interface ReferenceMetadata {
  /** Fields in THIS entity that reference OTHER entities */
  outgoing?: Array<{
    field: string;
    targetCollection: string;
    required?: boolean;
  }>;
  /** Fields in OTHER entities that reference THIS entity */
  incoming?: Array<{
    sourceCollection: string;
    sourceField: string;
    required?: boolean;
  }>;
}

/**
 * Find references to a document
 *
 * @param supabaseAdmin - Supabase admin client
 * @param collection - Collection name
 * @param docId - Document ID
 * @param referenceMetadata - Reference metadata from entity
 * @returns Array of reference information
 */
async function findReferences(
  supabaseAdmin: any,
  collection: string,
  docId: string,
  referenceMetadata?: ReferenceMetadata
): Promise<Array<{ collection: string; field: string; count: number }>> {
  const references: Array<{
    collection: string;
    field: string;
    count: number;
  }> = [];

  if (!referenceMetadata) {
    return references;
  }

  // Check incoming references (other entities reference this one)
  if (referenceMetadata.incoming) {
    for (const ref of referenceMetadata.incoming) {
      const { count, error } = await supabaseAdmin
        .from(ref.sourceCollection)
        .select('*', { count: 'exact', head: true })
        .eq(ref.sourceField, docId);

      if (!error && count && count > 0) {
        references.push({
          collection: ref.sourceCollection,
          field: ref.sourceField,
          count,
        });
      }
    }
  }

  // Check outgoing references (this entity references others)
  // Note: Outgoing references don't prevent deletion, but we track them for info
  if (referenceMetadata.outgoing) {
    // For now, we only check incoming references as they prevent deletion
    // Outgoing references are informational only
  }

  return references;
}

/**
 * Create a Supabase Edge Function handler for deleting an entity.
 *
 * @param collection - The Supabase table name
 * @param requiredRole - Minimum role required for this operation
 * @param referenceMetadata - Optional reference metadata for deletion checking
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseDeleteEntity(
  collection: string,
  requiredRole: UserRole,
  referenceMetadata?: ReferenceMetadata
) {
  const requestSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
  });

  return createSupabaseHandler(
    `delete_${collection}`,
    requestSchema,
    async (data: DeleteEntityRequest, ctx) => {
      const { id } = data;
      const { supabaseAdmin } = ctx;

      // G68: Warn when referenceMetadata.incoming is not configured
      if (referenceMetadata && !referenceMetadata.incoming) {
        console.warn(
          `[delete_${collection}] referenceMetadata provided but incoming is undefined — reference check skipped`
        );
      }

      // Check for references to this document
      const references = await findReferences(
        supabaseAdmin,
        collection,
        id,
        referenceMetadata
      );

      // Prevent deletion if required references exist
      const requiredReferences = references.filter((ref) => {
        const metadata = referenceMetadata?.incoming?.find(
          (r) =>
            r.sourceCollection === ref.collection && r.sourceField === ref.field
        );
        return metadata?.required === true;
      });

      if (requiredReferences.length > 0) {
        throw new DoNotDevError(
          'Cannot delete: item is referenced by other entities',
          'permission-denied',
          {
            details: {
              references: requiredReferences,
            },
          }
        );
      }

      // Delete document
      const { error } = await supabaseAdmin
        .from(collection)
        .delete()
        .eq('id', id);

      if (error) {
        throw new DoNotDevError(
          `Failed to delete entity: ${error.message}`,
          'internal'
        );
      }

      return { success: true };
    },
    requiredRole
  );
}
