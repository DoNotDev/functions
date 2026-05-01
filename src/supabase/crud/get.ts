// packages/functions/src/supabase/crud/get.ts

/**
 * @fileoverview Generic handler to retrieve a single entity from Supabase.
 * @description Provides a reusable implementation for retrieving documents from PostgreSQL with visibility filtering.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  filterVisibleFields,
  hasRoleAccess,
  HIDDEN_STATUSES,
} from '@donotdev/core/server';
import type { EntityOwnershipConfig, UserRole } from '@donotdev/core/server';
import {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
} from '@donotdev/supabase/server';

import { DoNotDevError } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';

/** Request payload for retrieving a single entity by ID. */
export type GetEntityRequest = { id: string };

/**
 * Create a Supabase Edge Function handler for getting a single entity.
 *
 * @param collection - The Supabase table name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @param ownership - Optional ownership config for visibility: 'owner' field masking
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseGetEntity(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole,
  ownership?: EntityOwnershipConfig
) {
  const requestSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
  });

  return createSupabaseHandler(
    `get_${collection}`,
    requestSchema,
    async (data: GetEntityRequest, ctx) => {
      const { id } = data;
      const { userRole, uid, supabaseAdmin } = ctx;

      // Query the document
      const { data: row, error } = await supabaseAdmin
        .from(collection)
        .select('*')
        .eq('id', id)
        .single();

      if (error || !row) {
        throw new DoNotDevError('Entity not found', 'not-found');
      }

      const isAdmin = hasRoleAccess(userRole, 'admin');

      // Hide drafts/deleted from non-admin users (security: hidden statuses never reach public)
      if (
        !isAdmin &&
        (HIDDEN_STATUSES as readonly string[]).includes(row.status)
      ) {
        throw new DoNotDevError('Entity not found', 'not-found');
      }

      // Normalize DB row to entity field names before filtering.
      const entityFieldNames = getEntityFieldNames(documentSchema);
      const entityMapper =
        entityFieldNames.length > 0
          ? createEntityAwareMapper(entityFieldNames)
          : defaultFieldMapper;
      const normalized = entityMapper.fromBackendRow(row) as Record<
        string,
        any
      >;

      const visibilityOptions =
        ownership && uid
          ? { documentData: normalized, uid, ownership }
          : undefined;

      // Filter fields based on visibility and user role (and ownership for visibility: 'owner')
      const filteredData = filterVisibleFields(
        normalized,
        documentSchema,
        userRole,
        visibilityOptions
      );

      // Supabase returns plain JSON (no Firestore Timestamp conversion needed)
      return {
        id: row.id,
        ...filteredData,
      };
    },
    requiredRole
  );
}
