// packages/functions/src/supabase/crud/create.ts

/**
 * @fileoverview Generic handler to create an entity in Supabase.
 * @description Provides a reusable implementation for creating documents in PostgreSQL with validation.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { filterVisibleFields } from '@donotdev/core/server';
import type { UserRole, UniqueKeyDefinition } from '@donotdev/core/server';
import { defaultFieldMapper } from '@donotdev/supabase/server';

import { createMetadata } from '../../shared/index.js';
import { DoNotDevError, validateDocument } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import { checkIdempotency, storeIdempotency } from '../utils/idempotency.js';

const mapper = defaultFieldMapper;

/** Request payload for creating an entity with optional idempotency. */
export type CreateEntityRequest = {
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
 * Normalize unique key fields in payload to lowercase (for strings)
 */
function normalizePayloadForUniqueKeys(
  payload: Record<string, any>,
  uniqueKeys: UniqueKeyDefinition[]
): Record<string, any> {
  const normalized = { ...payload };
  for (const uniqueKey of uniqueKeys) {
    for (const field of uniqueKey.fields) {
      if (typeof normalized[field] === 'string') {
        normalized[field] = normalized[field].toLowerCase();
      }
    }
  }
  return normalized;
}

/**
 * Check unique key constraints against existing documents
 */
async function checkUniqueKeys(
  collection: string,
  payload: Record<string, any>,
  uniqueKeys: UniqueKeyDefinition[],
  isDraft: boolean,
  supabaseAdmin: any
): Promise<
  | { found: false }
  | { found: true; existingDoc: Record<string, any>; findOrCreate: boolean }
> {
  for (const uniqueKey of uniqueKeys) {
    // Skip validation for drafts only if explicitly opted in
    if (isDraft && uniqueKey.skipForDrafts === true) continue;

    // Check if all fields in the unique key have values
    const allFieldsHaveValues = uniqueKey.fields.every(
      (field) => payload[field] != null && payload[field] !== ''
    );
    if (!allFieldsHaveValues) continue;

    let query = supabaseAdmin.from(collection).select('*');
    for (const field of uniqueKey.fields) {
      query = query.eq(
        mapper.toBackendField(field),
        normalizeValue(payload[field])
      );
    }

    const { data: existing, error } = await query.limit(1);

    if (!error && existing && existing.length > 0) {
      const existingDoc = mapper.fromBackendRow(existing[0]) as Record<
        string,
        any
      >;

      if (uniqueKey.findOrCreate) {
        return { found: true, existingDoc, findOrCreate: true };
      }

      // Throw duplicate error
      const fieldNames = uniqueKey.fields.join(' + ');
      throw new DoNotDevError(
        uniqueKey.errorMessage || `Duplicate ${fieldNames}`,
        'already-exists',
        {
          details: {
            fields: uniqueKey.fields,
            existingId: existingDoc.id,
          },
        }
      );
    }
  }

  return { found: false };
}

/**
 * Create a Supabase Edge Function handler for creating an entity.
 *
 * @param collection - The Supabase table name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseCreateEntity(
  collection: string,
  createDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  draftDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole
) {
  const requestSchema = v.object({
    payload: v.record(v.string(), v.any()),
    idempotencyKey: v.optional(v.string()),
  });

  return createSupabaseHandler(
    `create_${collection}`,
    requestSchema,
    async (data: CreateEntityRequest, ctx) => {
      const { payload, idempotencyKey } = data;
      const { uid, userRole, supabaseAdmin } = ctx;

      // Idempotency check if key provided
      if (idempotencyKey) {
        const cachedResult = await checkIdempotency<any>(
          supabaseAdmin,
          idempotencyKey,
          'create'
        );
        if (cachedResult) {
          return cachedResult;
        }
      }

      // New records start as drafts unless the caller explicitly sets a status.
      const status = payload.status ?? 'draft';
      const isDraft = status === 'draft';

      // Check unique keys if schema has metadata with uniqueKeys
      const schemaWithMeta = createDocumentSchema as {
        metadata?: { uniqueKeys?: UniqueKeyDefinition[] };
      };
      const uniqueKeys = schemaWithMeta.metadata?.uniqueKeys;

      if (uniqueKeys && uniqueKeys.length > 0) {
        const checkResult = await checkUniqueKeys(
          collection,
          payload,
          uniqueKeys,
          isDraft,
          supabaseAdmin
        );

        if (checkResult.found && checkResult.findOrCreate) {
          // G67: Apply same visibility filtering as normal create path
          return filterVisibleFields(
            checkResult.existingDoc,
            createDocumentSchema,
            userRole
          );
        }
      }

      // Normalize unique key fields to lowercase for case-insensitive storage
      const normalizedPayload =
        uniqueKeys && uniqueKeys.length > 0
          ? normalizePayloadForUniqueKeys(payload, uniqueKeys)
          : payload;

      // Validate against the appropriate schema.
      // Drafts must validate with `schemas.draft` so required fields become
      // nullish/optional (instead of failing strict `schemas.create`).
      const payloadForValidation = { ...normalizedPayload, status };
      validateDocument(
        payloadForValidation,
        isDraft ? draftDocumentSchema : createDocumentSchema
      );

      const metadata = createMetadata(uid);
      const snakeMetadata = mapper.toBackendKeys(
        metadata as Record<string, unknown>
      );

      const {
        createdAt,
        updatedAt,
        created_at,
        updated_at,
        ...payloadWithoutTimestamps
      } = normalizedPayload;
      const snakePayload = mapper.toBackendKeys(payloadWithoutTimestamps);

      // Insert document (DB sets created_at/updated_at via triggers)
      const { data: inserted, error } = await supabaseAdmin
        .from(collection)
        .insert({
          ...snakePayload,
          status,
          ...snakeMetadata,
        })
        .select()
        .single();

      if (error) {
        throw new DoNotDevError(
          `Failed to create entity: ${error.message}`,
          'internal'
        );
      }

      const result = mapper.fromBackendRow(
        inserted as Record<string, unknown>
      ) as Record<string, any>;

      // Store result for idempotency if key provided
      if (idempotencyKey) {
        await storeIdempotency(
          supabaseAdmin,
          idempotencyKey,
          'create',
          result,
          uid
        );
      }

      return result;
    },
    requiredRole
  );
}
