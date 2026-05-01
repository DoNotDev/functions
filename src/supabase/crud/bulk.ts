// packages/functions/src/supabase/crud/bulk.ts

/**
 * @fileoverview Supabase bulk CRUD handler.
 * @description Thin Supabase RPC adapter on top of the shared `executeBulk`
 *   orchestrator. Assembles a `supabaseAdmin.rpc('crud_bulk', ...)` call as
 *   the target-specific `transact` callback; all other policy (validation,
 *   collision, per-bucket ACL, metadata stamping, audit) lives in
 *   {@link executeBulk} so Firestore, Vercel, GraphQL and future REST-CRUD
 *   server aids share one correctness surface.
 *
 *   The Postgres RPC `crud_bulk` wraps `BEGIN ... COMMIT`, so one RPC call
 *   is one transaction from the client's perspective.
 *
 * @version 0.2.0
 * @since 0.6.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  BulkCollisionError,
  BulkRequestSchema,
  DoNotDevError,
} from '@donotdev/core/server';
import type {
  BulkRequest,
  BulkResponse,
  EntityAccessConfig,
  UserRole,
} from '@donotdev/core/server';
import { defaultFieldMapper } from '@donotdev/supabase/server';

import {
  createMetadata,
  executeBulk,
  updateMetadata,
} from '../../shared/index.js';
import { createSupabaseHandler } from '../baseFunction.js';

// =============================================================================
// Types & helpers
// =============================================================================

const mapper = defaultFieldMapper;

/** Request payload accepted by the bulk handler — mirrors {@link BulkRequestSchema}. */
export type BulkEntityRequest = BulkRequest;

/** Ordered list of role levels, low → high. Used to pick the strictest needed role. */
const ROLE_RANK: Record<UserRole, number> = {
  guest: 0,
  user: 1,
  admin: 2,
  super: 3,
};

/**
 * Strip client-supplied timestamps (DB triggers own them) and convert keys to
 * the snake_case shape the DB expects.
 */
function prepareInsertRow(
  row: Record<string, unknown>,
  uid: string
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { createdAt, updatedAt, created_at, updated_at, ...rest } =
    row as Record<string, unknown>;
  const snake = mapper.toBackendKeys(rest);
  const meta = mapper.toBackendKeys(
    createMetadata(uid) as Record<string, unknown>
  );
  return { ...snake, ...meta };
}

function preparePatch(
  patch: Record<string, unknown>,
  uid: string
): Record<string, unknown> {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const {
    createdAt,
    updatedAt,
    created_at,
    updated_at,
    id: _id,
    ...rest
  } = patch as Record<string, unknown>;
  const snake = mapper.toBackendKeys(rest);
  const meta = mapper.toBackendKeys(
    updateMetadata(uid) as Record<string, unknown>
  );
  return { ...snake, ...meta };
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create a Supabase Edge Function handler for atomic bulk CRUD on one collection.
 *
 * @description
 * One HTTP round-trip, one rate-limit hit, one audit line, one DB transaction.
 * Inserts, updates and deletes run in input order inside the `crud_bulk` RPC
 * which wraps `BEGIN ... COMMIT` — any failure triggers `ROLLBACK` and the
 * client observes a rejected promise with no partial state.
 *
 * The factory returns a handler that is auto-registered as `bulk_${collection}`
 * by {@link createSupabaseCrudFunctions}.
 *
 * @param collection - Postgres table name for the entity.
 * @param createSchema - Valibot schema validating each `inserts[]` row.
 * @param updateSchema - Valibot schema validating each `updates[].patch` object.
 * @param access - Entity access config; per-bucket role check runs before writes.
 * @returns A `(req: Request) => Promise<Response>` handler for `Deno.serve`.
 * @throws BulkCollisionError — via the thrown DoNotDevError when an id appears in two buckets.
 *
 * @example
 * ```typescript
 * // Auto-registration (preferred):
 * import * as entities from '../_shared/entities.ts';
 * import { createSupabaseCrudFunctions } from '@donotdev/functions/supabase';
 * const { serve } = createSupabaseCrudFunctions(entities);
 * Deno.serve(serve);
 * // POST { _functionName: 'bulk_events', inserts: [...], updates: [...], deletes: [...] }
 *
 * // Manual registration:
 * import { createSupabaseBulkEntity } from '@donotdev/functions/supabase';
 * import { eventEntity, eventCreateSchema, eventUpdateSchema } from '../_shared/entities.ts';
 * Deno.serve(createSupabaseBulkEntity(
 *   eventEntity.collection,
 *   eventCreateSchema,
 *   eventUpdateSchema,
 *   eventEntity.access,
 * ));
 * ```
 *
 * @version 0.2.0
 * @since 0.6.0
 */
export function createSupabaseBulkEntity(
  collection: string,
  createSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  draftCreateSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  updateSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  access: EntityAccessConfig
): (req: Request) => Promise<Response> {
  // The wrapper role is the strictest across the three buckets. Entities that
  // only configure a subset (e.g. read-only) collapse to 'user' so mixed-ACL
  // misalignments still reach the handler where `executeBulk` catches them
  // with a precise per-bucket error.
  const wrapperRole: UserRole = (() => {
    const roles: UserRole[] = [];
    if (access.create) roles.push(access.create);
    if (access.update) roles.push(access.update);
    if (access.delete) roles.push(access.delete);
    if (roles.length === 0) return 'user';
    return roles.reduce((a, b) => (ROLE_RANK[a] >= ROLE_RANK[b] ? a : b));
  })();

  return createSupabaseHandler(
    `bulk_${collection}`,
    BulkRequestSchema,
    async (data: BulkEntityRequest, ctx): Promise<BulkResponse> => {
      const { uid, userRole, supabaseAdmin } = ctx;

      try {
        return await executeBulk({
          collection,
          ops: data,
          createSchema,
          draftCreateSchema,
          updateSchema,
          access,
          uid,
          userRole,
          // Supabase's `crud_bulk` RPC mints ids server-side — skip the
          // client-side mint hook so the RPC owns the id space.
          stampInsertMetadata: prepareInsertRow,
          stampUpdateMetadata: preparePatch,
          transact: async ({ inserts, updates, deletes }) => {
            const { data: rpcResult, error: rpcError } =
              await supabaseAdmin.rpc('crud_bulk', {
                p_collection: collection,
                p_inserts: inserts.map((i) => i.row),
                p_updates: updates.map((u) => ({ id: u.id, patch: u.patch })),
                p_deletes: deletes,
              });
            if (rpcError) {
              throw new DoNotDevError(
                `Failed to execute bulk: ${rpcError.message}`,
                'internal'
              );
            }
            // RPC may return either camelCase or snake_case id arrays — normalise
            // before `executeBulk` runs its `BulkResponseSchema` validation.
            const raw = (rpcResult ?? {}) as Record<string, unknown>;
            return {
              insertedIds: Array.isArray(raw.insertedIds)
                ? (raw.insertedIds as string[])
                : Array.isArray(raw.inserted_ids)
                  ? (raw.inserted_ids as string[])
                  : [],
              updatedIds: Array.isArray(raw.updatedIds)
                ? (raw.updatedIds as string[])
                : Array.isArray(raw.updated_ids)
                  ? (raw.updated_ids as string[])
                  : [],
              deletedIds: Array.isArray(raw.deletedIds)
                ? (raw.deletedIds as string[])
                : Array.isArray(raw.deleted_ids)
                  ? (raw.deleted_ids as string[])
                  : [],
            };
          },
          audit: (event, { counts }) => {
            // One audit line per bulk (matches the "one audit entry"
            // contract). Sibling handlers use console.log for parity with
            // the edge-function logging expectations.
            console.log(
              `[${event}] uid=${uid} inserts=${counts.inserts} updates=${counts.updates} deletes=${counts.deletes}`
            );
          },
        });
      } catch (err) {
        // Translate the shared orchestrator's collision error into the
        // DoNotDevError shape expected by the Supabase wire contract
        // (invalid-argument + collision details in `details`).
        if (err instanceof BulkCollisionError) {
          throw new DoNotDevError(err.message, 'invalid-argument', {
            details: {
              collidingIds: err.collidingIds,
              where: err.where,
            },
          });
        }
        throw err;
      }
    },
    wrapperRole
  );
}
