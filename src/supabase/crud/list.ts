// packages/functions/src/supabase/crud/list.ts

/**
 * @fileoverview Generic handler to list entities from Supabase with pagination, filtering, and sorting.
 * @description Provides a reusable implementation for listing documents from PostgreSQL with advanced query capabilities.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

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
import {
  createEntityAwareMapper,
  defaultFieldMapper,
  getEntityFieldNames,
} from '@donotdev/supabase/server';

import { DoNotDevError } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';

/** Field mapper: app (camelCase) ↔ backend (snake_case). Single boundary for list handler. */
const mapper = defaultFieldMapper;

/** Ensure we only pass strings to the mapper (entity listFields/ownership can be mis-typed at runtime). */
function toBackendColumn(field: unknown): string {
  return mapper.toBackendField(
    typeof field === 'string' ? field : String(field)
  );
}

/** Request payload for listing entities with filtering, sorting, and pagination. */
export interface ListEntityRequest {
  where?: Array<[string, any, any]>;
  orderBy?: Array<[string, 'asc' | 'desc']>;
  limit?: number;
  startAfterId?: string; // Offset-based pagination (legacy)
  startAfterCursor?: string; // Keyset pagination (cursor-based)
  search?: {
    field: string;
    query: string;
  };
}

/**
 * Encode cursor for keyset pagination
 */
function encodeCursor(id: string, orderBy: Record<string, any>): string {
  const cursor = { id, orderBy };
  return Buffer.from(JSON.stringify(cursor)).toString('base64');
}

/**
 * Decode cursor for keyset pagination
 */
function decodeCursor(cursor: string): {
  id: string;
  orderBy: Record<string, any>;
} {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString());
    // G69: Validate decoded cursor has required fields and correct types
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      typeof parsed.id !== 'string' ||
      !parsed.id ||
      typeof parsed.orderBy !== 'object' ||
      parsed.orderBy === null ||
      Array.isArray(parsed.orderBy)
    ) {
      throw new DoNotDevError('Invalid cursor content', 'invalid-argument');
    }
    return parsed;
  } catch (error) {
    if (error instanceof DoNotDevError) throw error;
    throw new DoNotDevError('Invalid cursor format', 'invalid-argument');
  }
}

// G66: Validate field names — allow alphanumeric, underscore only. Reject prototype pollution vectors.
const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** Apply operator; column must already be backend (snake_case) name. */
function applyOperator(
  query: any,
  column: string,
  operator: string,
  value: any
): any {
  if (!SAFE_FIELD_NAME.test(column)) {
    throw new DoNotDevError(
      `Invalid field name: '${column}'`,
      'invalid-argument'
    );
  }
  switch (operator) {
    case '==':
      return query.eq(column, value);
    case '!=':
      return query.neq(column, value);
    case '>':
      return query.gt(column, value);
    case '>=':
      return query.gte(column, value);
    case '<':
      return query.lt(column, value);
    case '<=':
      return query.lte(column, value);
    case 'in':
      return query.in(column, Array.isArray(value) ? value : [value]);
    case 'not-in':
      return query.not(column, 'in', Array.isArray(value) ? value : [value]);
    case 'array-contains':
      return query.contains(column, [value]);
    case 'array-contains-any':
      return query.contains(column, Array.isArray(value) ? value : [value]);
    default:
      return query.eq(column, value);
  }
}

function applyPublicCondition(
  query: any,
  publicCondition: EntityOwnershipPublicCondition[]
): any {
  let q = query;
  for (const c of publicCondition) {
    q = applyOperator(q, toBackendColumn(c.field), c.op, c.value);
  }
  return q;
}

/**
 * Create a Supabase Edge Function handler for listing entities.
 *
 * @param collection - The Supabase table name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @param listFields - Optional array of field names to include (plus id)
 * @param ownership - Optional ownership config for list constraints and visibility: 'owner' masking
 * @param isListCard - When true and ownership is set, applies public condition; when false, applies "mine" filter
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseListEntities(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole,
  listFields?: string[],
  ownership?: EntityOwnershipConfig,
  isListCard?: boolean
) {
  const requestSchema = v.object({
    where: v.optional(v.array(v.tuple([v.string(), v.any(), v.any()]))),
    orderBy: v.optional(
      v.array(
        v.tuple([
          v.pipe(v.string(), v.minLength(1)),
          v.picklist(['asc', 'desc']),
        ])
      )
    ),
    limit: v.optional(v.pipe(v.number(), v.minValue(1))),
    startAfterId: v.optional(v.string()), // Offset-based (legacy)
    startAfterCursor: v.optional(v.string()), // Keyset pagination
    search: v.optional(
      v.object({
        field: v.string(),
        query: v.string(),
      })
    ),
  });

  return createSupabaseHandler(
    isListCard ? `listCard_${collection}` : `list_${collection}`,
    requestSchema,
    async (data: ListEntityRequest, ctx) => {
      const {
        where = [],
        orderBy = [],
        limit = 1000,
        startAfterId,
        startAfterCursor,
        search,
      } = data;
      const { userRole, uid, supabaseAdmin } = ctx;

      const isAdmin = hasRoleAccess(userRole, 'admin');

      // Build query - select fields (listFields + id + status, or *). Only use string entries (entity may be mis-typed).
      const safeListFields = listFields?.filter(
        (f): f is string => typeof f === 'string'
      );
      const selectFields =
        safeListFields && safeListFields.length > 0
          ? safeListFields.map((f) => toBackendColumn(f)).join(', ') +
            ', id, status'
          : '*';

      let query = supabaseAdmin
        .from(collection)
        .select(selectFields, { count: 'exact' });

      // Filter out hidden statuses for non-admin users
      if (!isAdmin) {
        query = query.not('status', 'in', [...HIDDEN_STATUSES]);
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
          const firstOwnerField = ownership.ownerFields[0];
          query = query.eq(toBackendColumn(firstOwnerField), uid);
        }
      }

      if (search) {
        // Validate search.field against entity schema (listFields as allowlist)
        if (safeListFields && safeListFields.length > 0) {
          if (!safeListFields.includes(search.field)) {
            throw new DoNotDevError(
              `Search field '${search.field}' is not allowed`,
              'invalid-argument'
            );
          }
        } else if (search.field.startsWith('_') || search.field.includes('.')) {
          // No schema available — reject obviously unsafe field names
          throw new DoNotDevError(
            `Search field '${search.field}' is not allowed`,
            'invalid-argument'
          );
        }
        // Escape SQL ILIKE wildcards to prevent wildcard injection
        const escapedQuery = search.query
          .replace(/%/g, '\\%')
          .replace(/_/g, '\\_');
        query = query.ilike(toBackendColumn(search.field), `%${escapedQuery}%`);
      }

      // Validate where clause fields against entity schema
      for (const [field, operator, value] of where) {
        if (safeListFields && safeListFields.length > 0) {
          if (
            !safeListFields.includes(field) &&
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
        query = applyOperator(query, toBackendColumn(field), operator, value);
      }

      const hasIdInOrderBy = orderBy.some(
        ([field]) => toBackendColumn(field) === 'id'
      );
      for (const [field, direction] of orderBy) {
        query = query.order(toBackendColumn(field), {
          ascending: direction === 'asc',
        });
      }
      // Add id as tiebreaker if not already in orderBy
      if (!hasIdInOrderBy && orderBy.length > 0) {
        query = query.order('id', { ascending: true });
      }

      // Pagination: keyset (cursor-based) or offset-based (legacy)
      let useKeysetPagination = false;
      if (startAfterCursor) {
        // Keyset pagination (preferred)
        useKeysetPagination = true;
        try {
          const cursor = decodeCursor(startAfterCursor);

          if (orderBy.length === 0) {
            query = query.gt('id', cursor.id);
          } else {
            const firstOrderFieldApp = orderBy[0][0];
            const firstOrderDirection = orderBy[0][1];
            const orderColumnBackend = toBackendColumn(firstOrderFieldApp);
            const cursorValue = cursor.orderBy[firstOrderFieldApp];
            if (firstOrderDirection === 'asc') {
              query = query.gte(orderColumnBackend, cursorValue);
            } else {
              query = query.lte(orderColumnBackend, cursorValue);
            }
          }
        } catch (error) {
          throw new DoNotDevError('Invalid cursor format', 'invalid-argument');
        }
        // Apply limit (will filter cursor item after fetch)
        query = query.limit(limit + 1); // Fetch one extra to check hasMore
      } else if (startAfterId) {
        // Offset-based pagination (legacy)
        const offset = parseInt(startAfterId, 10);
        if (isNaN(offset)) {
          throw new DoNotDevError('Invalid startAfterId', 'invalid-argument');
        }
        query = query.range(offset, offset + limit - 1);
      } else {
        // First page
        query = query.range(0, limit - 1);
      }

      // Execute query
      const { data: rows, error, count } = await query;

      if (error) {
        throw new DoNotDevError(
          `Failed to list entities: ${error.message}`,
          'internal'
        );
      }

      let items = (rows || []) as Record<string, any>[];

      // Filter out cursor item for keyset pagination.
      // Note: items are still raw DB rows here (pre-normalization), so mapper.toBackendField
      // is correct for accessing backend column values. entityMapper is used later for normalization.
      if (useKeysetPagination && startAfterCursor && items.length > 0) {
        try {
          const cursor = decodeCursor(startAfterCursor);
          items = items.filter((item) => {
            if (orderBy.length === 0) {
              return item.id !== cursor.id;
            }
            const firstOrderFieldApp = orderBy[0][0];
            const cursorValue = cursor.orderBy[firstOrderFieldApp];
            const itemValue = item[mapper.toBackendField(firstOrderFieldApp)];
            return !(item.id === cursor.id && itemValue === cursorValue);
          });
        } catch {
          // If cursor decode fails, continue with all items
        }
      }

      // Helper: Check if value is a Picture object
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
          const firstPicture = value[0];
          if (isPictureObject(firstPicture)) {
            return firstPicture.thumbUrl || firstPicture.fullUrl || null;
          }
          if (typeof firstPicture === 'string') {
            return firstPicture;
          }
        } else if (isPictureObject(value)) {
          return value.thumbUrl || value.fullUrl || null;
        }
        return value;
      };

      const visibilityOptions =
        ownership && uid ? { uid, ownership } : undefined;

      // Build entity-aware mapper from schema entries so fromBackendRow returns
      // entity field names (not blind camelCase), matching filterVisibleFields expectations.
      const entityFieldNames = getEntityFieldNames(documentSchema);
      const entityMapper =
        entityFieldNames.length > 0
          ? createEntityAwareMapper(entityFieldNames)
          : mapper;

      // Filter document fields based on visibility and user role
      const filteredItems = items.map((row) => {
        const camelRow = entityMapper.fromBackendRow(row) as Record<
          string,
          any
        >;
        const visibleData = filterVisibleFields(
          camelRow,
          documentSchema,
          userRole,
          visibilityOptions
            ? { ...visibilityOptions, documentData: camelRow }
            : undefined
        );

        // If listFields specified, filter to only those fields (plus id always)
        if (safeListFields && safeListFields.length > 0) {
          const filtered: Record<string, any> = { id: camelRow.id };
          for (const field of safeListFields) {
            if (field in visibleData) {
              const value = visibleData[field];
              filtered[field] = optimizePictureField(value);
            }
          }
          return filtered;
        }

        // No listFields restriction, return all visible fields (optimize pictures)
        const optimizedData: Record<string, any> = { id: camelRow.id };
        for (const [key, value] of Object.entries(visibleData)) {
          optimizedData[key] = optimizePictureField(value);
        }
        return optimizedData;
      });

      const hasMore = items.length === limit;

      // Generate cursor for keyset pagination or offset for legacy
      let lastVisible: string | null = null;
      if (hasMore && filteredItems.length > 0) {
        const lastItem = filteredItems[filteredItems.length - 1];
        if (useKeysetPagination && orderBy.length > 0) {
          // Create cursor from last item's orderBy field + id
          const firstOrderField = orderBy[0][0];
          const orderByValue: Record<string, any> = {};
          orderByValue[firstOrderField] = lastItem[firstOrderField];
          lastVisible = encodeCursor(lastItem.id, orderByValue);
        } else if (useKeysetPagination) {
          // No orderBy: just use id
          lastVisible = encodeCursor(lastItem.id, {});
        } else {
          // Offset-based: return offset + count
          const offset = startAfterId ? parseInt(startAfterId, 10) : 0;
          lastVisible = String(offset + items.length);
        }
      }

      return {
        items: filteredItems,
        lastVisible,
        count: count ?? undefined,
        hasMore,
      };
    },
    requiredRole
  );
}
