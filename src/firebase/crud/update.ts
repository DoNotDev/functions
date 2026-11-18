// packages/functions/src/firebase/crud/update.ts

/**
 * @fileoverview Generic function to update an entity.
 * @description Provides a reusable implementation for updating documents in Firestore with validation.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { Query, DocumentData } from 'firebase-admin/firestore';
import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';
import * as v from 'valibot';

import { prepareUpdate } from '@donotdev/core/server';
import type { UserRole, UniqueKeyDefinition } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import {
  prepareForFirestore,
  transformFirestoreData,
} from '../../shared/index.js';
import { updateMetadata } from '../../shared/index.js';
import { writtenOf } from '../../shared/crud/written.js';
import { DoNotDevError } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_CONFIG } from '../config/constants.js';

export type UpdateEntityRequest = {
  id: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: exported signature; narrowing it is a breaking change for importers (deferred to a major, any-audit 2026-11-11)
  payload: Record<string, any>;
  idempotencyKey?: string;
};

/**
 * Normalize a value for case-insensitive comparison
 * Lowercases strings, leaves other types unchanged
 */
function normalizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return value.toLowerCase();
  }
  return value;
}

/**
 * Normalize unique key fields in payload to lowercase (for strings)
 * Returns a new object with normalized values for unique key fields
 */
function normalizePayloadForUniqueKeys(
  payload: Record<string, unknown>,
  uniqueKeys: UniqueKeyDefinition[]
): Record<string, unknown> {
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
 * Checks unique key constraints for updates
 * Only checks if unique key fields are being modified
 * Excludes the current document from conflict check
 *
 * @param collection - Firestore collection name
 * @param currentDocId - ID of document being updated (excluded from check)
 * @param mergedData - Merged document data (current + payload)
 * @param payload - Update payload (only fields being changed)
 * @param uniqueKeys - Unique key definitions from entity
 * @param isDraft - Whether the resulting document is a draft
 */
async function checkUniqueKeysForUpdate(
  collection: string,
  currentDocId: string,
  mergedData: Record<string, unknown>,
  payload: Record<string, unknown>,
  uniqueKeys: UniqueKeyDefinition[],
  isDraft: boolean
): Promise<void> {
  const db = getFirebaseAdminFirestore();

  for (const uniqueKey of uniqueKeys) {
    // Skip validation for drafts only if explicitly opted in (default: false)
    if (isDraft && uniqueKey.skipForDrafts === true) continue;

    // Check if any of the unique key fields are being updated
    const isUpdatingUniqueKeyField = uniqueKey.fields.some(
      (field) => field in payload
    );
    if (!isUpdatingUniqueKeyField) continue;

    // Check if all fields in the unique key have values in merged data
    const allFieldsHaveValues = uniqueKey.fields.every(
      (field) => mergedData[field] != null && mergedData[field] !== ''
    );
    if (!allFieldsHaveValues) continue;

    // Build query for all fields in this unique key
    // Normalize values to lowercase for case-insensitive matching
    let query: Query<DocumentData> = db.collection(collection);
    for (const field of uniqueKey.fields) {
      query = query.where(field, '==', normalizeValue(mergedData[field]));
    }

    const existing = await query.limit(2).get(); // Get 2 to check if another doc exists

    // Check if any matching document is NOT the current document
    const conflictingDoc = existing.docs.find((doc) => doc.id !== currentDocId);

    if (conflictingDoc) {
      const fieldNames = uniqueKey.fields.join(' + ');
      throw new DoNotDevError(
        uniqueKey.errorMessage || `Duplicate ${fieldNames}`,
        'already-exists',
        {
          details: {
            fields: uniqueKey.fields,
            existingId: conflictingDoc.id,
          },
        }
      );
    }
  }
}

/**
 * Generic business logic for updating entities
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * Status rule: `prepareUpdate` (core/schemas crud/update). An update
 * entering a visible status (`updateCheck`, e.g. a draft published) is checked
 * whole: the merged document against the update schema (`validateWholeDocument`). The
 * parse output of the sent keys is written, never the raw payload.
 *
 * @param collection - The Firestore collection name
 * @param documentSchema - The update schema: validates `{ ...payload, id }` of a non-draft update (the whole merged document when it enters a visible status)
 * @param draftDocumentSchema - The draft schema: validates the merged document of a draft
 * @returns The callable logic (exported for unit tests)
 *
 * @version 0.2.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export function updateEntityLogicFactory(
  collection: string,
  documentSchema: v.GenericSchema,
  draftDocumentSchema: v.GenericSchema
) {
  return async function updateEntityLogic(
    data: UpdateEntityRequest,
    context: {
      uid: string;
      userRole: UserRole;
      request: CallableRequest<UpdateEntityRequest>;
    }
  ) {
    const { id, payload, idempotencyKey } = data;
    const { uid } = context;

    // W17: Validate idempotency key length and content.
    if (idempotencyKey !== undefined) {
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 256
      ) {
        throw new DoNotDevError(
          'idempotencyKey must be a non-empty string of at most 256 characters',
          'invalid-argument'
        );
      }
      if (!/^[\w\-.:@]+$/.test(idempotencyKey)) {
        throw new DoNotDevError(
          'idempotencyKey contains invalid characters',
          'invalid-argument'
        );
      }
    }

    // C9: Atomic idempotency check — reserve key in a transaction to eliminate TOCTOU race.
    if (idempotencyKey) {
      const db = getFirebaseAdminFirestore();
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`update_${idempotencyKey}`);

      let existingResult: unknown = undefined;
      let alreadyProcessed = false;

      await db.runTransaction(async (tx) => {
        const idempotencyDoc = await tx.get(idempotencyRef);
        if (idempotencyDoc.exists) {
          existingResult = idempotencyDoc.data()?.result;
          alreadyProcessed = true;
          return;
        }
        tx.set(idempotencyRef, {
          processing: true,
          reservedAt: new Date().toISOString(),
        });
      });

      if (alreadyProcessed) {
        return existingResult;
      }
    }

    // Get the document reference
    const db = getFirebaseAdminFirestore();
    const docRef = db.collection(collection).doc(id);

    // Check if the document exists
    const doc = await docRef.get();
    const storedData = doc.data();
    if (!doc.exists || storedData === undefined) {
      throw new DoNotDevError('Entity not found', 'not-found');
    }

    // Get the current data and merge with the update payload.
    // Note: simple spread merge — concurrent partial updates use last-write-wins, no conflict detection.
    const currentData = transformFirestoreData(storedData);
    const mergedData = { ...currentData, ...payload };

    // CRUD update rules (core/schemas crud/update) on the stored row, as on the client.
    const prepared = prepareUpdate(
      { draft: draftDocumentSchema, update: documentSchema },
      { id, patch: payload, stored: currentData }
    );
    const isDraft = prepared.schemaKey === 'draft';

    // Check unique keys if schema has metadata with uniqueKeys
    // Only checks fields that are being updated
    const schemaWithMeta = documentSchema as {
      metadata?: { uniqueKeys?: UniqueKeyDefinition[] };
    };
    const uniqueKeys = schemaWithMeta.metadata?.uniqueKeys;

    if (uniqueKeys && uniqueKeys.length > 0) {
      await checkUniqueKeysForUpdate(
        collection,
        id,
        mergedData,
        payload,
        uniqueKeys,
        isDraft
      );
    }

    // The rules' `written` (parsed sent keys), never the raw payload.
    const written = writtenOf(prepared, collection, 'update');

    // Normalize unique key fields to lowercase for case-insensitive storage
    const normalizedPayload =
      uniqueKeys && uniqueKeys.length > 0
        ? normalizePayloadForUniqueKeys(written, uniqueKeys)
        : written;

    // Prepare the update data for Firestore and add metadata
    const updateData = {
      ...prepareForFirestore(normalizedPayload),
      ...updateMetadata(uid),
    };

    // Update the document
    await docRef.update(updateData);

    // Retrieve the updated document
    const updatedDoc = await docRef.get();

    // Transform the document data back to the application format
    const result = transformFirestoreData({
      id: updatedDoc.id,
      ...updatedDoc.data(),
    });

    // Store result for idempotency if key provided
    if (idempotencyKey) {
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`update_${idempotencyKey}`);
      await idempotencyRef.set({
        result,
        processedAt: new Date().toISOString(),
        processedBy: uid,
      });
    }

    return result;
  };
}

/**
 * Generic function to update entities in any Firestore collection
 * @param collection - The Firestore collection name
 * @param documentSchema - The update schema (`createSchemas(entity).update`): validates what a non-draft update writes
 * @param draftDocumentSchema - The draft schema (`createSchemas(entity).draft`): validates the resulting document of a draft
 * @param requiredRole - Minimum role required for this operation
 * @param customSchema - Optional custom request schema
 * @returns Firebase callable function
 */
export const updateEntity = (
  collection: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: accepts schemas of any output type; v.GenericSchema would make InferOutput unknown for callers (breaking)
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: accepts schemas of any output type; v.GenericSchema would make InferOutput unknown for callers (breaking)
  draftDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: accepts schemas of any output type; v.GenericSchema would make InferOutput unknown for callers (breaking)
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: exported signature; narrowing it is a breaking change for importers (deferred to a major, any-audit 2026-11-11)
): CallableFunction<UpdateEntityRequest, Promise<any>> => {
  const requestSchema =
    customSchema ||
    v.object({
      id: v.pipe(v.string(), v.minLength(1)),
      payload: v.record(v.string(), v.unknown()),
      idempotencyKey: v.optional(v.string()),
    });

  return createBaseFunction(
    CRUD_CONFIG,
    requestSchema,
    'update_entity',
    updateEntityLogicFactory(collection, documentSchema, draftDocumentSchema),
    requiredRole
  );
};
