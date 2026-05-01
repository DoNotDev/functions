// packages/functions/src/firebase/crud/delete.ts

/**
 * @fileoverview Generic function to delete an entity.
 * @description Provides a reusable implementation for deleting documents in Firestore with reference checking.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import * as v from 'valibot';

import type { UserRole } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { DoNotDevError, findReferences } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_CONFIG } from '../config/constants.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

export type DeleteEntityRequest = { id: string };

/**
 * Generic business logic for deleting entities
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function deleteEntityLogicFactory(collection: string) {
  return async function deleteEntityLogic(
    data: DeleteEntityRequest,
    context: { uid: string; userRole: UserRole; request: CallableRequest<any> }
  ) {
    const { id } = data;

    // Check for references to this document
    const references = await findReferences(collection, id);

    // Prevent deletion if references exist
    if (references.length > 0) {
      throw new DoNotDevError(
        'Cannot delete: item is referenced by other entities',
        'permission-denied',
        { details: { references } }
      );
    }

    // Delete the document
    const db = getFirebaseAdminFirestore();
    await db.collection(collection).doc(id).delete();

    return { success: true };
  };
}

/**
 * Generic function to delete entities from any Firestore collection
 * @param collection - The Firestore collection name
 * @param requiredRole - Minimum role required for this operation
 * @param customSchema - Optional custom request schema
 * @returns Firebase callable function
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const deleteEntity = (
  collection: string,
  requiredRole: UserRole,
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
): CallableFunction<DeleteEntityRequest, Promise<{ success: boolean }>> => {
  const requestSchema =
    customSchema ||
    v.object({
      id: v.pipe(v.string(), v.minLength(1)),
    });

  return createBaseFunction(
    CRUD_CONFIG,
    requestSchema,
    'delete_entity',
    deleteEntityLogicFactory(collection),
    requiredRole
  );
};
