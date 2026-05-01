// packages/functions/src/supabase/crud/update.ts

/**
 * @fileoverview Generic handler to update an entity in Supabase.
 * @description Provides a reusable implementation for updating documents in PostgreSQL with validation.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { UserRole, UniqueKeyDefinition } from '@donotdev/core/server';
import { defaultFieldMapper } from '@donotdev/supabase/server';

import { updateMetadata } from '../../shared/index.js';
import { DoNotDevError, validateDocument } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { checkIdempotency, storeIdempotency } from '../utils/idempotency.js';

const mapper = defaultFieldMapper;

/** Request payload for updating an entity by ID with optional idempotency. */
export type UpdateEntityRequest = {
  id: string;
  payload: Record<string, any>;
  idempotencyKey?: string;
};

/**
 * Normalize a value for case-insensitive comparison
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  return value;
}

/**
 * Check unique key constraints for modified fields only
 */
async function checkUniqueKeys(
  collection: string,
  id: string,
  payload: Record<string, any>,
  uniqueKeys: UniqueKeyDefinition[],
  isDraft: boolean,
  supabaseAdmin: any
): Promise<void> {
  for (const uniqueKey of uniqueKeys) {
    if (isDraft && uniqueKey.skipForDrafts === true) continue;

    // Only check fields that are being modified
    const modifiedFields = uniqueKey.fields.filter((field) => field in payload);
    if (modifiedFields.length === 0) continue;

    // Check if all fields in the unique key have values
    const allFieldsHaveValues = uniqueKey.fields.every(
      (field) => payload[field] != null && payload[field] !== ''
    );
    if (!allFieldsHaveValues) continue;

    // Build query excluding current document
    let query = supabaseAdmin.from(collection).select('*');
    for (const field of uniqueKey.fields) {
      query = query.eq(
        mapper.toBackendField(field),
        normalizeValue(payload[field])
      );
    }
    query = query.neq('id', id);

    const { data: existing, error } = await query.limit(1);

    if (!error && existing && existing.length > 0) {
      const fieldNames = uniqueKey.fields.join(' + ');
      throw new DoNotDevError(
        uniqueKey.errorMessage || `Duplicate ${fieldNames}`,
        'already-exists',
        {
          details: {
            fields: uniqueKey.fields,
            existingId: existing[0].id,
          },
        }
      );
    }
  }
}

/**
 * Create a Supabase Edge Function handler for updating an entity.
 *
 * @param collection - The Supabase table name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseUpdateEntity(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole
) {
  const requestSchema = v.object({
    id: v.pipe(v.string(), v.minLength(1)),
    payload: v.record(v.string(), v.any()),
    idempotencyKey: v.optional(v.string()),
  });

  return createSupabaseHandler(
    `update_${collection}`,
    requestSchema,
    async (data: UpdateEntityRequest, ctx) => {
      const { id, payload, idempotencyKey } = data;
      const { uid, supabaseAdmin } = ctx;

      // Idempotency check if key provided
      if (idempotencyKey) {
        const cachedResult = await checkIdempotency<any>(
          supabaseAdmin,
          idempotencyKey,
          'update'
        );
        if (cachedResult) {
          return cachedResult;
        }
      }

      // Fetch existing document
      const { data: existing, error: fetchError } = await supabaseAdmin
        .from(collection)
        .select('*')
        .eq('id', id)
        .single();

      if (fetchError || !existing) {
        throw new DoNotDevError('Entity not found', 'not-found');
      }

      // G75: `existing` comes from DB in snake_case, converted to camelCase via fromBackendRow.
      // `payload` arrives from the client in camelCase. The merge produces a camelCase object
      // which is later converted back to snake_case via toBackendKeys before the UPDATE query.
      const merged = {
        ...(mapper.fromBackendRow(existing) as Record<string, any>),
        ...payload,
      };
      const status = merged.status ?? existing.status;
      const isDraft = status === 'draft';

      // Check unique keys if schema has metadata with uniqueKeys
      const schemaWithMeta = documentSchema as {
        metadata?: { uniqueKeys?: UniqueKeyDefinition[] };
      };
      const uniqueKeys = schemaWithMeta.metadata?.uniqueKeys;

      if (uniqueKeys && uniqueKeys.length > 0) {
        await checkUniqueKeys(
          collection,
          id,
          merged,
          uniqueKeys,
          isDraft,
          supabaseAdmin
        );
      }

      // Validate merged document (skip for drafts)
      if (!isDraft) {
        validateDocument(merged, documentSchema);
      }

      const metadata = updateMetadata(uid);
      const snakeMetadata = mapper.toBackendKeys(
        metadata as Record<string, unknown>
      );

      const {
        createdAt,
        updatedAt,
        created_at,
        updated_at,
        id: _id,
        ...payloadWithoutTimestamps
      } = payload;
      const snakePayload = mapper.toBackendKeys(payloadWithoutTimestamps);

      // Update document (DB sets updated_at via trigger)
      const { data: updated, error } = await supabaseAdmin
        .from(collection)
        .update({
          ...snakePayload,
          ...snakeMetadata,
        })
        .eq('id', id)
        .select()
        .single();

      if (error) {
        throw new DoNotDevError(
          `Failed to update entity: ${error.message}`,
          'internal'
        );
      }

      const result = mapper.fromBackendRow(updated) as Record<string, any>;

      // Store result for idempotency if key provided
      if (idempotencyKey) {
        await storeIdempotency(
          supabaseAdmin,
          idempotencyKey,
          'update',
          result,
          uid
        );
      }

      return result;
    },
    requiredRole
  );
}
