// packages/functions/src/shared/crud/written.ts

/**
 * @fileoverview What a server write stores
 * @description The server side of a CRUD rule result (`prepareCreate` / `prepareUpdate` /
 * `prepareRemove`, core/schemas crud/): logs the unknown fields (CRUD rule 8: neither
 * silent nor blocking) and returns the stored values or throws. Every server write site
 * (bulk, create, update, entity store) calls it.
 *
 * @version 0.1.0
 * @since 0.3.0
 * @author AMBROISE PARK Consulting
 */

import { DoNotDevError } from '@donotdev/core/server';
import type { PreparedWrite } from '@donotdev/core/server';

/**
 * The values a server write stores.
 *
 * @param result - The CRUD rule result
 * @param collection - Collection written (named in the log and the error)
 * @param locator - Write site / row (e.g. `update`, `inserts[2]`)
 * @returns The rule's `written`
 * @throws {DoNotDevError} `invalid-argument` with `details.validationErrors` (the server wire
 *   contract, a Firebase `FunctionsErrorCode`) when the write is invalid
 *
 * @example
 * ```typescript
 * const row = writtenOf(prepareCreate(schemas, payload), collection, 'create');
 * ```
 *
 * @version 0.1.0
 * @since 0.3.0
 * @author AMBROISE PARK Consulting
 */
export function writtenOf(
  result: PreparedWrite,
  collection: string,
  locator: string
): Record<string, unknown> {
  if (result.unknownKeys.length > 0) {
    console.warn(
      `[dndev] ${collection} ${locator}: fields the entity does not have, not written: ${result.unknownKeys.join(', ')}`
    );
  }
  if (result.ok) return result.written;
  const messages = result.issues
    .map((issue) => `${issue.path?.map((p) => String(p.key)).join('.') || 'root'}: ${issue.message}`)
    .join('; ');
  throw new DoNotDevError(
    `Validation failed on ${collection} ${locator}: ${messages}`,
    'invalid-argument',
    { details: { validationErrors: result.issues } }
  );
}
