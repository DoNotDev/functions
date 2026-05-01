// packages/functions/src/firebase/crud/bulk.ts

/**
 * @fileoverview Firebase bulk CRUD handler.
 * @description Thin Firestore adapter on top of the shared `executeBulk`
 *   orchestrator. Assembles a firebase-admin `runTransaction` as the
 *   target-specific `transact` callback and keeps the wire contract
 *   frozen: one HTTP round-trip, one transaction, one audit line, one
 *   rate-limit hit. Validation + collision + per-bucket ACL + metadata
 *   stamping all live in {@link executeBulk}.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import { logger } from 'firebase-functions/v2';
import * as v from 'valibot';

import { BulkRequestSchema, DEFAULT_STATUS_VALUE } from '@donotdev/core/server';
import type {
  BulkRequest,
  BulkResponse,
  UserRole,
} from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import {
  createMetadata,
  executeBulk,
  prepareForFirestore,
  updateMetadata,
} from '../../shared/index.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_CONFIG } from '../config/constants.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

/**
 * Request type for the bulk endpoint. Identical to the wire schema; kept as a
 * named alias for parity with `CreateEntityRequest`, `UpdateEntityRequest`, etc.
 */
export type BulkEntityRequest = BulkRequest;

/**
 * Per-operation access split. The three write access roles are passed
 * individually so the factory can enforce them independently when a request
 * mixes op kinds (e.g. only the delete bucket fails ACL).
 */
interface BulkAccess {
  /** Minimum role to insert into the collection. */
  create: UserRole;
  /** Minimum role to update existing rows. */
  update: UserRole;
  /** Minimum role to delete rows. */
  delete: UserRole;
}

/**
 * Build the business-logic function consumed by {@link createBaseFunction}.
 *
 * Exported for unit testing only — the public entry is {@link bulkEntity}
 * which wraps this factory with auth, role, rate-limit, and schema
 * validation at the transport boundary.
 *
 * The logic itself is a pure delegation to {@link executeBulk}; the only
 * Firestore-specific code lives inside the `transact` closure which issues
 * `tx.set / tx.update / tx.delete` on pre-minted `doc()` references.
 *
 * @internal
 *
 * @example
 * ```typescript
 * const logic = bulkEntityLogicFactory('cars', createSchema, updateSchema, {
 *   create: 'user', update: 'user', delete: 'admin',
 * });
 * await logic({ inserts: [{ name: 'a' }] }, { uid: 'u', userRole: 'user', request: req });
 * ```
 *
 * @version 0.2.0
 * @since 0.2.0
 */
export function bulkEntityLogicFactory(
  collection: string,
  createSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  draftCreateSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  updateSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  access: BulkAccess
) {
  return async function bulkEntityLogic(
    data: BulkEntityRequest,
    context: { uid: string; userRole: UserRole; request: CallableRequest<any> }
  ): Promise<BulkResponse> {
    const { uid, userRole } = context;

    // `getFirebaseAdminFirestore()` / `.collection()` are lazy — resolved only
    // when a populated bucket forces `executeBulk` past its empty
    // short-circuit. Keeps the no-op bulk contract free of DB touches.
    let cachedCollectionRef: ReturnType<
      ReturnType<typeof getFirebaseAdminFirestore>['collection']
    > | null = null;
    const col = () => {
      if (!cachedCollectionRef) {
        cachedCollectionRef =
          getFirebaseAdminFirestore().collection(collection);
      }
      return cachedCollectionRef;
    };

    return executeBulk({
      collection,
      ops: data,
      createSchema,
      draftCreateSchema,
      updateSchema,
      access,
      uid,
      userRole,
      // Mint ids via Firestore's `doc()` — gives us stable ids across retry
      // of the transaction callback (Firestore may run it more than once).
      mintInsertId: () => col().doc().id,
      stampInsertMetadata: (row, creatorUid) => {
        const status =
          (row.status as string | undefined) ?? DEFAULT_STATUS_VALUE;
        return {
          ...prepareForFirestore(row),
          status,
          ...createMetadata(creatorUid),
        };
      },
      stampUpdateMetadata: (patch, editorUid) => ({
        ...prepareForFirestore(patch),
        ...updateMetadata(editorUid),
      }),
      transact: async ({ inserts, updates, deletes }) => {
        const collectionRef = col();
        return getFirebaseAdminFirestore().runTransaction(async (tx) => {
          const insertedIds: string[] = [];
          const updatedIds: string[] = [];
          const deletedIds: string[] = [];

          // Writes are issued synchronously on the transaction object — no
          // Promise.all — so Firestore sees a deterministic op sequence.
          for (const { id, row } of inserts) {
            tx.set(collectionRef.doc(id), row);
            insertedIds.push(id);
          }
          for (const { id, patch } of updates) {
            tx.update(collectionRef.doc(id), patch);
            updatedIds.push(id);
          }
          for (const id of deletes) {
            tx.delete(collectionRef.doc(id));
            deletedIds.push(id);
          }

          return { insertedIds, updatedIds, deletedIds };
        });
      },
      audit: (event, { counts }) => {
        logger.info(event, {
          uid,
          collection,
          inserts: counts.inserts,
          updates: counts.updates,
          deletes: counts.deletes,
        });
      },
    });
  };
}

/**
 * Generic function to perform transactional bulk CRUD in any Firestore
 * collection. Auto-registered as `bulk_${collection}` by
 * {@link createCrudFunctions}.
 *
 * **Atomicity contract** — all inserts / updates / deletes succeed or none
 * do. On any failure the entire Firestore transaction is rolled back and the
 * error is surfaced to the caller via `DoNotDevError`.
 *
 * **One of everything** — one HTTP round-trip, one transaction, one audit
 * entry (`crud.bulk.${collection}` with counts), one rate-limit hit (at
 * `createBaseFunction` entry). Collisions and schema validation fail *before*
 * the transaction is opened.
 *
 * @param collection - The Firestore collection name.
 * @param createSchema - Valibot schema to validate each insert payload.
 * @param updateSchema - Valibot schema to validate each update patch.
 * @param access - Required roles split per op kind.
 * @returns Firebase callable function returning a `BulkResponse`.
 *
 * @throws {BulkCollisionError} When the same id appears in `updates`+`deletes`
 *   or `inserts`+`updates`. No writes are attempted.
 * @throws {DoNotDevError} `permission-denied` when the caller lacks the
 *   per-op role (e.g. includes deletes but has no delete access).
 * @throws {DoNotDevError} `invalid-argument` when any insert fails
 *   `createSchema` or any update patch fails `updateSchema`. Transaction is
 *   not opened.
 *
 * @example
 * ```typescript
 * // Usually wired automatically by createCrudFunctions:
 * import { createCrudFunctions } from '@donotdev/functions/firebase';
 * import * as entities from 'entities';
 *
 * export const crud = createCrudFunctions(entities);
 * // → crud.bulk_cars, crud.bulk_orders, etc.
 *
 * // Manual wiring:
 * import { bulkEntity } from '@donotdev/functions/firebase';
 * import { createSchemas } from '@donotdev/core/server';
 * import { carEntity } from './entities/car';
 *
 * const schemas = createSchemas(carEntity);
 * export const bulk_cars = bulkEntity(
 *   carEntity.collection,
 *   schemas.create,
 *   schemas.update,
 *   carEntity.access,
 * );
 * ```
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */
export const bulkEntity = (
  collection: string,
  createSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  draftCreateSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  updateSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  access: BulkAccess
): CallableFunction<BulkEntityRequest, Promise<BulkResponse>> => {
  // The weakest role across the three ops is the function-level gate — a
  // caller who can insert but not delete should still reach the handler so we
  // can return a precise per-op permission-denied if they attempt a delete.
  const requiredRole = weakestRole(access);

  return createBaseFunction(
    CRUD_CONFIG,
    BulkRequestSchema,
    `bulk_${collection}`,
    bulkEntityLogicFactory(
      collection,
      createSchema,
      draftCreateSchema,
      updateSchema,
      access
    ),
    requiredRole
  );
};

/**
 * Returns the weakest (most-permissive) role across the three bulk op kinds.
 * Role hierarchy: `guest < user < admin < super`.
 *
 * @param access - Per-op roles.
 * @returns The role that satisfies at least one of the three ops.
 */
function weakestRole(access: BulkAccess): UserRole {
  const order: UserRole[] = ['guest', 'user', 'admin', 'super'];
  const rank = (r: UserRole) => order.indexOf(r);
  const min = [access.create, access.update, access.delete].reduce((a, b) =>
    rank(a) <= rank(b) ? a : b
  );
  return min;
}
