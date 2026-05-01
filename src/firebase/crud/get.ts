// packages/functions/src/firebase/crud/get.ts

/**
 * @fileoverview Generic function to retrieve a single entity.
 * @description Provides a reusable implementation for retrieving documents from Firestore with visibility filtering.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  filterVisibleFields,
  hasRoleAccess,
  HIDDEN_STATUSES,
} from '@donotdev/core/server';
import type { EntityOwnershipConfig, UserRole } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { transformFirestoreData } from '../../shared/index.js';
import { DoNotDevError } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_READ_CONFIG } from '../config/constants.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

export type GetEntityRequest = { id: string };

/**
 * Generic business logic for getting entities
 * Base function handles: validation, auth, rate limiting, monitoring
 */
function getEntityLogicFactory(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  ownership?: EntityOwnershipConfig
) {
  return async function getEntityLogic(
    data: GetEntityRequest,
    context: { uid: string; userRole: UserRole; request: CallableRequest<any> }
  ) {
    const { id } = data;
    const { userRole, uid } = context;

    // Get the document reference
    const db = getFirebaseAdminFirestore();
    const docRef = db.collection(collection).doc(id);

    // Retrieve the document
    const doc = await docRef.get();

    // Check if the document exists
    if (!doc.exists) {
      throw new DoNotDevError('Entity not found', 'not-found');
    }

    const isAdmin = hasRoleAccess(userRole, 'admin'); // Uses role hierarchy

    // Hide drafts/deleted from non-admin users (security: hidden statuses never reach public)
    const docData = doc.data();
    if (
      !isAdmin &&
      (HIDDEN_STATUSES as readonly string[]).includes(docData?.status)
    ) {
      throw new DoNotDevError('Entity not found', 'not-found');
    }

    const rawData = docData || {};
    const visibilityOptions =
      ownership && uid ? { documentData: rawData, uid, ownership } : undefined;

    // Filter fields based on visibility and user role (and ownership for visibility: 'owner')
    const filteredData = filterVisibleFields(
      rawData,
      documentSchema,
      userRole,
      visibilityOptions
    );

    // Transform the document data back to the application format
    return transformFirestoreData({
      id: doc.id,
      ...filteredData,
    });
  };
}

/**
 * Generic function to get entities from any Firestore collection
 * @param collection - The Firestore collection name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @param customSchema - Optional custom request schema
 * @param ownership - Optional ownership config for visibility: 'owner' field masking
 * @returns Firebase callable function
 */
export const getEntity = (
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole,
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  ownership?: EntityOwnershipConfig
): CallableFunction<GetEntityRequest, Promise<any>> => {
  const requestSchema =
    customSchema ||
    v.object({
      id: v.pipe(v.string(), v.minLength(1)),
    });

  return createBaseFunction(
    CRUD_READ_CONFIG,
    requestSchema,
    'get_entity',
    getEntityLogicFactory(collection, documentSchema, ownership),
    requiredRole
  );
};
