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

const mapper = defaultFieldMapper;

/** Request payload for aggregate operations (COUNT, SUM, AVG, MIN, MAX) on entities. */
export type AggregateEntityRequest = {
  where?: Array<[string, any, any]>;
  aggregate: {
    field: string;
    operation: 'count' | 'sum' | 'avg' | 'min' | 'max';
  };
  groupBy?: string[];
};

function applyOperator(
  query: any,
  column: string,
  operator: string,
  value: any
): any {
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
 * Create a Supabase Edge Function handler for aggregating entities.
 *
 * @param collection - The Supabase table name
 * @param documentSchema - The Valibot schema for document validation
 * @param requiredRole - Minimum role required for this operation
 * @returns A `(req: Request) => Promise<Response>` handler for Deno.serve
 */
export function createSupabaseAggregateEntities(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  requiredRole: UserRole
) {
  const requestSchema = v.object({
    where: v.optional(v.array(v.tuple([v.string(), v.any(), v.any()]))),
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Dynamic aggregate builder; Supabase types change across chained calls
      let query: any = supabaseAdmin.from(collection);

      for (const [field, operator, value] of where) {
        query = applyOperator(
          query,
          mapper.toBackendField(field),
          operator,
          value
        );
      }

      if (groupBy && groupBy.length > 0) {
        const groupByColumns = groupBy
          .map((f) => mapper.toBackendField(f))
          .join(', ');
        const selectFields = `${groupByColumns}, ${aggregate.operation}(${aggregateColumn})`;
        query = query.select(selectFields);
        for (const field of groupBy) {
          query = query.group(mapper.toBackendField(field));
        }
      } else {
        if (aggregate.operation === 'count') {
          query = query.select('*', { count: 'exact', head: true });
        } else {
          query = query.select(aggregateColumn);
        }
      }

      // Execute query
      const { data: rows, error, count } = await query;

      if (error) {
        throw new DoNotDevError(
          `Failed to aggregate entities: ${error.message}`,
          'internal'
        );
      }

      // Process results
      if (groupBy && groupBy.length > 0) {
        const grouped: Record<string, number> = {};
        for (const row of (rows || []) as any[]) {
          const groupKey = groupBy
            .map((f) => row[mapper.toBackendField(f)])
            .join('|');
          grouped[groupKey] = row[`${aggregate.operation}`] || 0;
        }
        return { value: grouped };
      } else {
        // Single aggregate value
        if (aggregate.operation === 'count') {
          return { value: count ?? 0 };
        } else {
          // Calculate aggregate from rows
          const values = (rows || ([] as any[]))
            .map((row: any) => row[aggregateColumn])
            .filter((v: any) => v != null && !isNaN(Number(v)))
            .map((v: any) => Number(v));

          if (values.length === 0) {
            return { value: 0 };
          }

          let result: number;
          switch (aggregate.operation) {
            case 'sum':
              result = values.reduce((a: number, b: number) => a + b, 0);
              break;
            case 'avg':
              result =
                values.reduce((a: number, b: number) => a + b, 0) /
                values.length;
              break;
            case 'min':
              result = Math.min(...values);
              break;
            case 'max':
              result = Math.max(...values);
              break;
            default:
              result = 0;
          }

          return { value: result };
        }
      }
    },
    requiredRole
  );
}
