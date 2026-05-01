// packages/functions/src/firebase/registerCrudFunctions.ts

/**
 * @fileoverview Auto-register CRUD functions from entities
 * @description Utility to automatically generate CRUD Cloud Functions for all entities
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { createSchemas, getListCardFieldNames } from '@donotdev/core/server';
import type { Entity } from '@donotdev/core/server';

import {
  bulkEntity,
  createEntity,
  getEntity,
  updateEntity,
  deleteEntity,
  listEntities,
} from './crud/index.js';

import type { HttpsFunction } from 'firebase-functions/v2/https';

interface RegisterOptions {
  prefix?: string;
}

/** CRUD functions object returned by createCrudFunctions */
export type CrudFunctions = Record<string, HttpsFunction>;

/**
 * Create CRUD functions for all entities (ESM-friendly)
 * Returns an object of functions that can be spread/exported
 *
 * @param entities - Object of { key: Entity } (from `import * as entities from 'entities'`)
 * @param options - Optional configuration
 * @returns Object of CRUD functions keyed by name
 *
 * @example
 * ```typescript
 * // ESM pattern - use with build-time export generation
 * import * as entities from 'entities';
 * import { createCrudFunctions } from '@donotdev/functions/firebase';
 *
 * export const crud = createCrudFunctions(entities);
 * // Build process generates: export const { create_cars, ... } = crud;
 * ```
 */
export function createCrudFunctions(
  entities: Record<string, Entity | unknown>,
  options: RegisterOptions = {}
): CrudFunctions {
  const { prefix = '' } = options;
  const functions: CrudFunctions = {};

  for (const [key, value] of Object.entries(entities)) {
    if (!isEntity(value)) continue;

    const entity = value as Entity;
    const col = entity.collection;
    const schemas = createSchemas(entity);
    const access = entity.access;

    functions[`${prefix}create_${col}`] = createEntity(
      col,
      schemas.create,
      schemas.draft,
      access.create
    );
    functions[`${prefix}get_${col}`] = getEntity(
      col,
      schemas.get,
      access.read,
      undefined,
      entity.ownership
    );
    // Use schemas.get for visibility filtering, entity.listFields for field selection
    // When ownership is set: list = "mine" filter, listCard = public condition
    functions[`${prefix}list_${col}`] = listEntities(
      col,
      schemas.get,
      access.read,
      undefined,
      entity.listFields,
      entity.ownership,
      false
    );
    // Always create listCard - uses same schemas.get, field selection via listCardFields ?? listFields ?? undefined
    functions[`${prefix}listCard_${col}`] = listEntities(
      col,
      schemas.get,
      access.read,
      undefined,
      getListCardFieldNames(entity),
      entity.ownership,
      true
    );
    functions[`${prefix}update_${col}`] = updateEntity(
      col,
      schemas.update,
      access.update
    );
    functions[`${prefix}delete_${col}`] = deleteEntity(col, access.delete);
    functions[`${prefix}bulk_${col}`] = bulkEntity(
      col,
      schemas.create,
      schemas.draft,
      schemas.update,
      {
        create: access.create,
        update: access.update,
        delete: access.delete,
      }
    );
  }

  return functions;
}

/**
 * @deprecated Use createCrudFunctions() for ESM. This mutates target which doesn't work in ESM.
 * Auto-register CRUD functions for all entities (CJS pattern)
 */
export function registerCrudFunctions(
  entities: Record<string, Entity | unknown>,
  target?: Record<string, any>,
  options: RegisterOptions = {}
): CrudFunctions {
  const functions = createCrudFunctions(entities, options);

  // If target provided, mutate it (CJS compat)
  if (target) {
    Object.assign(target, functions);
  }

  return functions;
}

/**
 * Type guard to check if a value is an Entity
 */
function isEntity(value: unknown): value is Entity {
  return (
    typeof value === 'object' &&
    value !== null &&
    'collection' in value &&
    'fields' in value
  );
}
