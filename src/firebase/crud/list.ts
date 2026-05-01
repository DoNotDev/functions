// packages/functions/src/firebase/crud/list.ts

/**
 * @fileoverview Generic function to list entities with pagination, filtering, and sorting.
 * @description Provides a reusable implementation for listing documents from Firestore with advanced query capabilities.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import * as v from 'valibot';

import {
  filterVisibleFields,
  hasRoleAccess,
  HIDDEN_STATUSES,
} from '@donotdev/core/server';
import type {
  EntityOwnershipConfig,
  EntityOwnershipPublicCondition,
  UserRole,
} from '@donotdev/core/server';
import type { Query } from '@donotdev/firebase/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { transformFirestoreData } from '../../shared/index.js';
import { DoNotDevError } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_READ_CONFIG } from '../config/constants.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

export interface ListEntityRequest {
  where?: Array<[string, any, any]>;
  orderBy?: Array<[string, 'asc' | 'desc']>;
  limit?: number;
  startAfterId?: string;
  search?: {
    field: string;
    query: string;
  };
}

/**
 * Apply public-condition where clauses to a query (for listCard when ownership is set).
 */
function applyPublicCondition(
  query: Query,
  publicCondition: EntityOwnershipPublicCondition[]
): Query {
  let q = query;
  for (const c of publicCondition) {
    q = q.where(c.field, c.op as any, c.value);
  }
  return q;
}

/**
 * Generic business logic for listing entities
 * Base function handles: validation, auth, rate limiting, monitoring
 */
function listEntitiesLogicFactory(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  listFields?: string[],
  ownership?: EntityOwnershipConfig,
  isListCard?: boolean
) {
  return async function listEntitiesLogic(
    data: ListEntityRequest,
    context: {
      uid: string;
      userRole: UserRole;
      request: CallableRequest<ListEntityRequest>;
    }
  ) {
    const { where = [], orderBy = [], limit, startAfterId, search } = data;
    // Extract uid and userRole once (reused for all document masking)
    const { userRole, uid } = context;

    const isAdmin = hasRoleAccess(userRole, 'admin'); // Uses role hierarchy

    // Start with a Query (not a CollectionReference)
    const db = getFirebaseAdminFirestore();
    let query: Query = db.collection(collection);

    // Filter out hidden statuses for non-admin users (security: drafts/deleted never reach public)
    if (!isAdmin) {
      query = query.where('status', 'not-in', [...HIDDEN_STATUSES]);
    }

    // Ownership: when set and not admin, listCard = public condition, list = mine filter
    if (ownership && !isAdmin) {
      if (
        isListCard &&
        ownership.publicCondition &&
        ownership.publicCondition.length > 0
      ) {
        query = applyPublicCondition(query, ownership.publicCondition);
      } else if (!isListCard && ownership.ownerFields.length > 0) {
        // G53: Multiple ownerFields are not supported in a single Firestore query.
        // Throw an explicit error instead of silently degrading to first field only.
        if (ownership.ownerFields.length > 1) {
          throw new DoNotDevError(
            `Multiple ownerFields (${ownership.ownerFields.join(', ')}) are not supported for Firestore list queries. Use a single ownerIds array field with array-contains instead.`,
            'invalid-argument'
          );
        }
        const firstOwnerField = ownership.ownerFields[0];
        query = query.where(firstOwnerField, '==', uid);
      }
    }

    // Apply search if provided
    if (search) {
      const { field, query: searchQuery } = search;
      // Validate search.field against entity schema (listFields as allowlist)
      if (listFields && listFields.length > 0) {
        if (!listFields.includes(field)) {
          throw new DoNotDevError(
            `Search field '${field}' is not allowed`,
            'invalid-argument'
          );
        }
      } else if (field.startsWith('_') || field.includes('.')) {
        throw new DoNotDevError(
          `Search field '${field}' is not allowed`,
          'invalid-argument'
        );
      }
      query = query
        .where(field, '>=', searchQuery)
        .where(field, '<=', searchQuery + '\uf8ff');
    }

    // Apply where clauses for filtering — validate field names against entity schema
    for (const [field, operator, value] of where) {
      if (listFields && listFields.length > 0) {
        if (
          !listFields.includes(field) &&
          field !== 'status' &&
          field !== 'id'
        ) {
          throw new DoNotDevError(
            `Where field '${field}' is not allowed`,
            'invalid-argument'
          );
        }
      } else if (field.startsWith('_') || field.includes('.')) {
        throw new DoNotDevError(
          `Where field '${field}' is not allowed`,
          'invalid-argument'
        );
      }
      query = query.where(field, operator, value);
    }

    // Apply ordering
    for (const [field, direction] of orderBy) {
      query = query.orderBy(field, direction);
    }

    // Apply pagination with startAfterId
    if (startAfterId) {
      const startAfterDoc = await db
        .collection(collection)
        .doc(startAfterId)
        .get();

      if (!startAfterDoc.exists) {
        throw new DoNotDevError('Start after document not found', 'not-found');
      }

      query = query.startAfter(startAfterDoc);
    }

    // W13: Cap at MAX_LIST_LIMIT to prevent unbounded reads (DoS via cost amplification).
    const MAX_LIST_LIMIT = 1000;
    const effectiveLimit =
      limit !== undefined && limit > 0
        ? Math.min(limit, MAX_LIST_LIMIT)
        : MAX_LIST_LIMIT;
    // G56: Warn when the requested limit exceeds MAX_LIST_LIMIT
    if (limit !== undefined && limit > MAX_LIST_LIMIT) {
      logger.warn(
        `[list_entities] Requested limit ${limit} exceeds MAX_LIST_LIMIT (${MAX_LIST_LIMIT}), capping`,
        {
          requestedLimit: limit,
          effectiveLimit,
          collection,
        }
      );
    }
    query = query.limit(effectiveLimit);

    // Execute the query
    const snapshot = await query.get();

    // Helper: Check if value is a Picture object (has thumbUrl and fullUrl)
    const isPictureObject = (value: any): boolean => {
      return (
        typeof value === 'object' &&
        value !== null &&
        'thumbUrl' in value &&
        'fullUrl' in value
      );
    };

    // Helper: Optimize picture fields for listCard (only return first picture's thumbUrl)
    const optimizePictureField = (value: any): any => {
      if (Array.isArray(value) && value.length > 0) {
        // Array of pictures - return just the first picture's thumbUrl
        const firstPicture = value[0];
        if (isPictureObject(firstPicture)) {
          return firstPicture.thumbUrl || firstPicture.fullUrl || null;
        }
        // If first item is a string, return it as-is
        if (typeof firstPicture === 'string') {
          return firstPicture;
        }
      } else if (isPictureObject(value)) {
        // Single picture object - return thumbUrl
        return value.thumbUrl || value.fullUrl || null;
      }
      // Not a picture, return as-is
      return value;
    };

    const visibilityOptions = ownership && uid ? { uid, ownership } : undefined;

    // Filter document fields based on visibility and user role (uid/userRole from context, once)
    const docs = snapshot.docs.map((doc: any) => {
      const rawData = doc.data() || {};
      const visibleData = filterVisibleFields(
        rawData,
        documentSchema,
        userRole,
        visibilityOptions
          ? { ...visibilityOptions, documentData: rawData }
          : undefined
      );

      // If listFields specified, filter to only those fields (plus id always)
      if (listFields && listFields.length > 0) {
        const filtered: Record<string, any> = { id: doc.id };
        for (const field of listFields) {
          if (field in visibleData) {
            const value = visibleData[field];
            // Optimize picture fields for list views (only need first thumbUrl)
            filtered[field] = optimizePictureField(value);
          }
        }
        return filtered;
      }

      // No listFields restriction, return all visible fields
      // Still optimize picture fields for all list queries (datatables only need thumbUrl)
      const optimizedData: Record<string, any> = { id: doc.id };
      for (const [key, value] of Object.entries(visibleData)) {
        optimizedData[key] = optimizePictureField(value);
      }
      return optimizedData;
    });

    // Return the paginated result with metadata
    return {
      items: transformFirestoreData(docs),
      lastVisible: snapshot.docs[snapshot.docs.length - 1]?.id || null,
      count: snapshot.docs.length,
      hasMore: snapshot.docs.length === effectiveLimit,
    };
  };
}

/**
 * Generic function to list entities from any Firestore collection
 * @param collection - The Firestore collection name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @param customSchema - Optional custom request schema
 * @param listFields - Optional array of field names to include (plus id). If not provided, all visible fields are returned.
 * @param ownership - Optional ownership config for list constraints and visibility: 'owner' masking
 * @param isListCard - When true and ownership is set, applies public condition; when false, applies "mine" filter
 * @returns Firebase callable function
 */
export const listEntities = (
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole,
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  listFields?: string[],
  ownership?: EntityOwnershipConfig,
  isListCard?: boolean
): CallableFunction<ListEntityRequest, Promise<any>> => {
  const requestSchema =
    customSchema ||
    v.object({
      where: v.optional(v.array(v.tuple([v.string(), v.any(), v.any()]))),
      orderBy: v.optional(
        v.array(v.tuple([v.string(), v.picklist(['asc', 'desc'])]))
      ),
      limit: v.optional(v.pipe(v.number(), v.minValue(1), v.maxValue(1000))),
      startAfterId: v.optional(v.string()),
      search: v.optional(
        v.object({
          field: v.string(),
          query: v.string(),
        })
      ),
    });

  return createBaseFunction(
    CRUD_READ_CONFIG,
    requestSchema,
    'list_entities',
    listEntitiesLogicFactory(
      collection,
      documentSchema,
      listFields,
      ownership,
      isListCard
    ),
    requiredRole
  );
};
