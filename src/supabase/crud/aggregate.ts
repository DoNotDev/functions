// packages/functions/src/supabase/crud/aggregate.ts

/**
 * @fileoverview Generic handler to aggregate entities in Supabase.
 * @description Provides aggregate operations (COUNT, SUM, AVG, MIN, MAX, GROUP BY) for PostgreSQL.
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import type { UserRole } from '@donotdev/core/server';
import { defaultFieldMapper } from '@donotdev/supabase/server';

import { DoNotDevError } from '../../shared/utils.js';
import { createSupabaseHandler } from '../baseFunction.js';
import type { Filterable } from './entityStore.js';

const mapper = defaultFieldMapper;

/** Request payload for aggregate operations (COUNT, SUM, AVG, MIN, MAX) on entities. */
export type AggregateEntityRequest = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: exported request type; consumers reading where values would get unknown (breaking)
  where?: Array<[string, any, any]>;
  aggregate: {
    field: string;
    operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
  };
  groupBy?: string[];
};

function applyOperator<Q extends Filterable>(
  query: Q,
  column: string,
  operator: string,
  value: unknown
): Q {
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
    default:
      return query.eq(column, value);
  }
}

/**
 * Aggregate one column over rows. `count` counts rows; the numeric operations
 * ignore null and non-numeric values and return 0 when none remain.
 */
function reduceRows(
  rows: Record<string, unknown>[],
  operation: AggregateEntityRequest['aggregate']['operation'],
  column: string
): number {
  if (operation === 'count') return rows.length;

  const values = rows
    .map((row) => row[column])
    .filter((value) => value != null && !isNaN(Number(value)))
    .map(Number);
  if (values.length === 0) return 0;

  switch (operation) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0);
    case 'avg':
      return values.reduce((a, b) => a + b, 0) / values.length;
    case 'min':
      return Math.min(...values);
    case 'max':
      return Math.max(...values);
  }
}

/**
 * Create a Supabase Edge Function handler for aggregating entities.
 *
 * @param collection - The Supabase table name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseAggregateEntities(
  collection: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: accepts schemas of any output type; v.GenericSchema would make InferOutput unknown for callers (breaking)
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole
) {
  const requestSchema = v.object({
    where: v.optional(v.array(v.tuple([v.string(), v.unknown(), v.unknown()]))),
    aggregate: v.object({
      field: v.string(),
      operation: v.picklist(['count', 'sum', 'avg', 'min', 'max']),
    }),
    groupBy: v.optional(v.array(v.string())),
  });

  return createSupabaseHandler(
    `aggregate_${collection}`,
    requestSchema,
    async (data: AggregateEntityRequest, ctx) => {
      const { where = [], aggregate, groupBy } = data;
      const { supabaseAdmin } = ctx;

      const aggregateColumn = mapper.toBackendField(aggregate.field);
      const groupColumns = (groupBy ?? []).map((f) => mapper.toBackendField(f));
      const isGrouped = groupColumns.length > 0;
      const isUngroupedCount = !isGrouped && aggregate.operation === 'count';

      // select() first: filters exist on the filter builder it returns, not on from().
      // Ungrouped count needs no rows (head request); otherwise fetch only the
      // group and aggregate columns and aggregate in JS (PostgREST has no GROUP BY).
      const selectColumns = isUngroupedCount
        ? '*'
        : [
            ...new Set([
              ...groupColumns,
              ...(aggregate.operation === 'count' ? [] : [aggregateColumn]),
            ]),
          ].join(', ');
      let query = isUngroupedCount
        ? supabaseAdmin
            .from(collection)
            .select(selectColumns, { count: 'exact', head: true })
        : supabaseAdmin.from(collection).select(selectColumns);

      for (const [field, operator, value] of where) {
        query = applyOperator(
          query,
          mapper.toBackendField(field),
          operator,
          value
        );
      }

      const { data: rows, error, count } = await query;

      if (error) {
        throw new DoNotDevError(
          `Failed to aggregate entities: ${error.message}`,
          'internal'
        );
      }

      if (isUngroupedCount) {
        return { value: count ?? 0 };
      }

      // why: select() with a runtime column string types rows as a parser-error type
      const typedRows = (rows ?? []) as unknown as Record<string, unknown>[];

      if (!isGrouped) {
        return {
          value: reduceRows(typedRows, aggregate.operation, aggregateColumn),
        };
      }

      const groups = new Map<string, Record<string, unknown>[]>();
      for (const row of typedRows) {
        const groupKey = groupColumns.map((c) => String(row[c])).join('|');
        const groupRows = groups.get(groupKey);
        if (groupRows) groupRows.push(row);
        else groups.set(groupKey, [row]);
      }
      const grouped: Record<string, number> = {};
      for (const [groupKey, groupRows] of groups) {
        grouped[groupKey] = reduceRows(
          groupRows,
          aggregate.operation,
          aggregateColumn
        );
      }
      return { value: grouped };
    },
    requiredRole
  );
}
