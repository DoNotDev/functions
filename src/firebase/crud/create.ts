// packages/functions/src/firebase/crud/create.ts

/**
 * @fileoverview Generic function to create an entity.
 * @description Provides a reusable implementation for creating documents in Firestore with validation.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import * as v from 'valibot';

import type { UserRole, UniqueKeyDefinition } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import {
  prepareForFirestore,
  transformFirestoreData,
} from '../../shared/index.js';
import { createMetadata } from '../../shared/index.js';
import { DoNotDevError, validateDocument } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_CONFIG } from '../config/constants.js';

import type { Query, DocumentData } from 'firebase-admin/firestore';
import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

export type CreateEntityRequest = {
  payload: Record<string, any>;
  idempotencyKey?: string;
};

/**
 * Result of unique key check
 */
type UniqueKeyCheckResult =
  | { found: false }
  | { found: true; existingDoc: Record<string, any>; findOrCreate: boolean };

/**
 * Checks unique key constraints against existing documents
 * Returns the first matching document if findOrCreate is enabled
 *
 * @param collection - Firestore collection name
 * @param payload - Document data to check
 * @param uniqueKeys - Unique key definitions from entity
 * @param isDraft - Whether the document is a draft
 * @returns Check result with existing document if found
 */
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

async function checkUniqueKeys(
  collection: string,
  payload: Record<string, any>,
  uniqueKeys: UniqueKeyDefinition[],
  isDraft: boolean
): Promise<UniqueKeyCheckResult> {
  const db = getFirebaseAdminFirestore();

  for (const uniqueKey of uniqueKeys) {
    // Skip validation for drafts only if explicitly opted in (default: false)
    if (isDraft && uniqueKey.skipForDrafts === true) continue;

    // Check if all fields in the unique key have values
    const allFieldsHaveValues = uniqueKey.fields.every(
      (field) => payload[field] != null && payload[field] !== ''
    );
    if (!allFieldsHaveValues) continue;

    // Build query for all fields in this unique key
    // Normalize values to lowercase for case-insensitive matching
    let query: Query<DocumentData> = db.collection(collection);
    for (const field of uniqueKey.fields) {
      query = query.where(field, '==', normalizeValue(payload[field]));
    }

    const existing = await query.limit(1).get();

    if (!existing.empty) {
      const firstDoc = existing.docs[0]!;
      const existingDoc = transformFirestoreData({
        id: firstDoc.id,
        ...firstDoc.data(),
      });

      if (uniqueKey.findOrCreate) {
        // Return existing document for findOrCreate behavior
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
            existingId: firstDoc.id,
          },
        }
      );
    }
  }

  return { found: false };
}

/**
 * Generic business logic for creating entities
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function createEntityLogicFactory(
  collection: string,
  createDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  draftDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
) {
  return async function createEntityLogic(
    data: CreateEntityRequest,
    context: { uid: string; userRole: UserRole; request: CallableRequest<any> }
  ) {
    const { payload, idempotencyKey } = data;
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

    // C9: Atomic idempotency check — reserve key in a transaction to eliminate
    // the TOCTOU race where two concurrent requests both read "not exists" and
    // both proceed to create a duplicate document.
    if (idempotencyKey) {
      const db = getFirebaseAdminFirestore();
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`create_${idempotencyKey}`);

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

    // New records start as drafts unless the caller explicitly sets a status.
    const status = payload.status ?? 'draft';
    const isDraft = status === 'draft';

    // Check unique keys if schema has metadata with uniqueKeys
    // This handles findOrCreate behavior and duplicate prevention
    const schemaWithMeta = createDocumentSchema as {
      metadata?: { uniqueKeys?: UniqueKeyDefinition[] };
    };
    const uniqueKeys = schemaWithMeta.metadata?.uniqueKeys;

    if (uniqueKeys && uniqueKeys.length > 0) {
      const checkResult = await checkUniqueKeys(
        collection,
        payload,
        uniqueKeys,
        isDraft
      );

      if (checkResult.found && checkResult.findOrCreate) {
        // G54: Log when returning existing document instead of creating new one
        logger.info(
          '[create_entity] findOrCreate: returning existing document',
          {
            collection,
            existingId: checkResult.existingDoc.id,
          }
        );
        return checkResult.existingDoc;
      }
      // If found but not findOrCreate, checkUniqueKeys already threw an error
    }

    // Normalize unique key fields to lowercase for case-insensitive storage
    const normalizedPayload =
      uniqueKeys && uniqueKeys.length > 0
        ? normalizePayloadForUniqueKeys(payload, uniqueKeys)
        : payload;

    // Validate the document against the appropriate schema.
    // Drafts must validate against `schemas.draft` so required fields become
    // nullish/optional (so `null` empties don't fail strict `schemas.create`).
    const payloadForValidation = { ...normalizedPayload, status };
    if (isDraft) {
      validateDocument(payloadForValidation, draftDocumentSchema);
    } else {
      validateDocument(payloadForValidation, createDocumentSchema);
    }

    // Prepare the document for Firestore and add metadata
    // Always ensure status is set
    const documentData = {
      ...prepareForFirestore(normalizedPayload),
      status, // Ensure status is always present
      ...createMetadata(uid),
    };

    // Save the document to Firestore
    const db = getFirebaseAdminFirestore();
    const docRef = await db.collection(collection).add(documentData);

    // Retrieve the created document
    const doc = await docRef.get();

    // Transform the document data back to the application format
    const result = transformFirestoreData({
      id: doc.id,
      ...doc.data(),
    });

    // Store result for idempotency if key provided
    if (idempotencyKey) {
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`create_${idempotencyKey}`);
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
 * Generic function to create entities in any Firestore collection
 * @param collection - The Firestore collection name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @param customSchema - Optional custom request schema
 * @returns Firebase callable function
 */
export const createEntity = (
  collection: string,
  createDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  draftDocumentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole,
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
): CallableFunction<CreateEntityRequest, Promise<any>> => {
  const requestSchema =
    customSchema ||
    v.object({
      payload: v.record(v.string(), v.any()),
      idempotencyKey: v.optional(v.string()),
    });

  return createBaseFunction(
    CRUD_CONFIG,
    requestSchema,
    'create_entity',
    createEntityLogicFactory(
      collection,
      createDocumentSchema,
      draftDocumentSchema
    ),
    requiredRole
  );
};
