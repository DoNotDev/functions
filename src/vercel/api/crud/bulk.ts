// packages/functions/src/vercel/api/crud/bulk.ts

/**
 * @fileoverview Vercel bulk / transactional CRUD API handler.
 * @description Vercel Pages-Router API route for `POST /api/crud/:collection/bulk`.
 *   Thin HTTP adapter on top of the shared `executeBulk` orchestrator —
 *   assembles a firebase-admin `runTransaction` as the target `transact`
 *   callback.
 *
 *   Unlike the Firebase Callable and Supabase Edge variants, this endpoint
 *   does not carry entity schemas on the wire (the REST-CRUD client hits
 *   `${baseUrl}/${collection}/bulk` with raw ops only). The wire contract
 *   is still frozen: structural parsing via `BulkRequestSchema`, collision
 *   rejection, empty no-op, id preservation in input order.
 *
 * @version 0.2.0
 * @since 0.2.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  BulkCollisionError,
  BulkInsertSchema,
  BulkRequestSchema,
} from '@donotdev/core/server';
import type { BulkRequest, BulkResponse } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import {
  createMetadata,
  executeBulk,
  prepareForFirestore,
  updateMetadata,
} from '../../../shared/index.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';
import { validateCollectionName } from '../../../shared/utils.js';

import type { NextApiRequest, NextApiResponse } from 'next';

/**
 * Pass-through row schema — the bulk endpoint is URL-routed and does not
 * carry entity schemas on the wire, so per-row validation reduces to the
 * structural checks already enforced by {@link BulkRequestSchema}. Both
 * inserts and update patches are opaque objects at this layer.
 */
const PASSTHROUGH_INSERT_SCHEMA = BulkInsertSchema;
const PASSTHROUGH_PATCH_SCHEMA = v.record(v.string(), v.unknown());

/**
 * HTTP handler for `POST /api/crud/:collection/bulk`.
 *
 * Wire contract: the request body is parsed with `BulkRequestSchema` and
 * the response body with `BulkResponseSchema`. On success, returns
 * `{ insertedIds, updatedIds, deletedIds }` — each array preserves the
 * input order of its bucket so clients can zip returned ids back onto
 * optimistic cache entries.
 *
 * Semantics (non-negotiable — see `BULK_CRUD_TODO.md`):
 *   1. Atomic — a single Firestore transaction wraps every write.
 *   2. Collision rejection — same id in `updates` + `deletes`, or
 *      `inserts` + `updates`, throws `BulkCollisionError` before any
 *      read or write.
 *   3. Empty bulk — `{}` short-circuits to a zeroed response; no DB work.
 *   4. Order preserved — output arrays mirror the input order.
 *
 * The collection name is read from `req.query.collection` (Next.js
 * dynamic route segment `[collection]`).
 *
 * @example
 * ```typescript
 * // File: pages/api/crud/[collection]/bulk.ts (Next.js Pages Router)
 * export { default } from '@donotdev/functions/vercel';
 * ```
 *
 * @version 0.2.0
 * @since 0.2.0
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — rejects unauthenticated callers before any DB work.
    const uid = await verifyAuthToken(req);

    // W22: Validate collection name from the URL segment.
    // `[collection]` route param is exposed via `req.query.collection`.
    const rawCollection = req.query.collection;
    const collection =
      typeof rawCollection === 'string' ? rawCollection : rawCollection?.[0];
    if (!collection) {
      handleError(new Error('Missing collection'));
    }
    validateCollectionName(collection as string);

    // Structurally parse the body up-front so a malformed payload produces a
    // stable 400 (executeBulk also runs this parse, but it surfaces the error
    // as a DoNotDevError — we intercept here to preserve the wire shape
    // `{ error: string }` that existing clients expect for 400s).
    const parseResult = v.safeParse(BulkRequestSchema, req.body);
    if (!parseResult.success) {
      return res.status(400).json({
        error: `Validation failed: ${parseResult.issues
          .map((e) => e.message)
          .join(', ')}`,
      });
    }
    const ops: BulkRequest = parseResult.output;

    const response: BulkResponse = await executeBulk({
      collection: collection as string,
      ops,
      // The URL-routed wire contract does not carry entity schemas. We pass
      // the structural row schemas so per-row validation is a no-op beyond
      // what `BulkRequestSchema` already enforces.
      createSchema: PASSTHROUGH_INSERT_SCHEMA,
      updateSchema: PASSTHROUGH_PATCH_SCHEMA,
      // URL-routed handler has no entity ACL config — the per-bucket ACL in
      // `executeBulk` still enforces "populated bucket requires role", so we
      // advertise 'user' across the three buckets (the surrounding auth layer
      // has already verified the token).
      access: { create: 'user', update: 'user', delete: 'user' },
      uid,
      userRole: 'user',
      mintInsertId: () =>
        getFirebaseAdminFirestore()
          .collection(collection as string)
          .doc().id,
      stampInsertMetadata: (row, creatorUid) => ({
        ...prepareForFirestore(row),
        ...createMetadata(creatorUid),
      }),
      stampUpdateMetadata: (patch, editorUid) => ({
        ...prepareForFirestore(patch),
        ...updateMetadata(editorUid),
      }),
      transact: async ({ inserts, updates, deletes }) => {
        const db = getFirebaseAdminFirestore();
        const col = db.collection(collection as string);

        return db.runTransaction(async (tx) => {
          // Reads first (Firestore transactions require all reads before
          // writes). For updates and deletes we verify document existence
          // so a stale patch does not silently create a new row via tx.set
          // and a stale delete surfaces a clear error.
          const updateSnapshots = await Promise.all(
            updates.map((u) => tx.get(col.doc(u.id)))
          );
          for (let i = 0; i < updateSnapshots.length; i++) {
            if (!updateSnapshots[i]!.exists) {
              throw new Error(
                `Document not found: ${collection as string}/${updates[i]!.id}`
              );
            }
          }
          const deleteSnapshots = await Promise.all(
            deletes.map((id) => tx.get(col.doc(id)))
          );
          for (let i = 0; i < deleteSnapshots.length; i++) {
            if (!deleteSnapshots[i]!.exists) {
              throw new Error(
                `Document not found: ${collection as string}/${deletes[i]!}`
              );
            }
          }

          // Writes — inserts, then updates, then deletes. Order within a
          // transaction is not observable to readers (atomic commit) but we
          // preserve it for determinism and log clarity.
          const insertedIds: string[] = [];
          for (const { id, row } of inserts) {
            tx.set(col.doc(id), row);
            insertedIds.push(id);
          }
          const updatedIds: string[] = [];
          for (const { id, patch } of updates) {
            tx.update(col.doc(id), patch);
            updatedIds.push(id);
          }
          const deletedIds: string[] = [];
          for (const id of deletes) {
            tx.delete(col.doc(id));
            deletedIds.push(id);
          }

          return { insertedIds, updatedIds, deletedIds };
        });
      },
    });

    // The wire contract returns ids only, not the mutated rows. Consumers
    // re-query if they need fresh snapshots (mirrors the REST semantics of
    // a 200 with a summary body).
    return res.status(200).json(response);
  } catch (error) {
    try {
      handleError(error);
    } catch (handledError: any) {
      // BulkCollisionError surfaces as 400 (invalid-argument) because the
      // caller sent an incoherent payload — same class as schema failure.
      const isCollision = error instanceof BulkCollisionError;
      const status =
        isCollision || handledError.code === 'invalid-argument' ? 400 : 500;
      return res
        .status(status)
        .json({ error: handledError.message, code: handledError.code });
    }
  }
}
