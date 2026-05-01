// packages/functions/src/firebase/crud/aggregate.ts

/**
 * @fileoverview Generic function to aggregate entities with metrics and grouping.
 * @description Provides a reusable implementation for computing aggregations on Firestore collections.
 * Returns only computed metrics, never raw data - optimized for analytics dashboards.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { hasRoleAccess } from '@donotdev/core/server';
import type { UserRole } from '@donotdev/core/server';
import { getFirebaseAdminFirestore } from '@donotdev/firebase/server';

import { isFieldVisible } from '../../shared/schema.js';
import { DoNotDevError } from '../../shared/utils.js';
import { createBaseFunction } from '../baseFunction.js';
import { CRUD_CONFIG } from '../config/constants.js';

import type { CallableRequest } from 'firebase-functions/v2/https';

/** Supported aggregation operations */
export type AggregateOperation = 'count' | 'sum' | 'avg' | 'min' | 'max';

/** Single metric definition */
export interface MetricDefinition {
  /** Field to aggregate ('*' for count all) */
  field: string;
  /** Aggregation operation */
  operation: AggregateOperation;
  /** Output name for this metric */
  as: string;
  /** Optional filter for this metric */
  filter?: {
    field: string;
    operator: '==' | '!=' | '>' | '<' | '>=' | '<=';
    value: any;
  };
}

/** Group by definition */
export interface GroupByDefinition {
  /** Field to group by */
  field: string;
  /** Metrics to compute per group */
  metrics: MetricDefinition[];
}

/** Aggregation configuration */
export interface AggregateConfig {
  /** Top-level metrics (computed on entire collection) */
  metrics?: MetricDefinition[];
  /** Group by configurations */
  groupBy?: GroupByDefinition[];
  /** Optional global filters */
  where?: Array<[string, any, any]>;
}

/** Request schema for aggregate function */
interface AggregateRequest {
  /** Optional runtime filters (merged with config filters) */
  where?: Array<[string, any, any]>;
  /** Optional date range filter */
  dateRange?: {
    field: string;
    start?: string;
    end?: string;
  };
}

/**
 * Extracts visibility from a Valibot field schema
 */
function getFieldVisibilityFromSchema(
  schema: any,
  fieldName: string
): string | undefined {
  if (!schema?.entries?.[fieldName]) return undefined;
  const field = schema.entries[fieldName];
  return field?.visibility;
}

/**
 * Checks if user can access a field for aggregation
 */
function canAggregateField(
  fieldName: string,
  schema: any,
  isAdmin: boolean
): boolean {
  // '*' is always allowed (count all)
  if (fieldName === '*') return true;

  const visibility = getFieldVisibilityFromSchema(schema, fieldName);
  return isFieldVisible(fieldName, visibility as any, isAdmin);
}

/**
 * Returns the effective (discounted) amount for a price field.
 * Matches display/formula: amount * (1 - discountPercent/100). Plain numbers unchanged.
 */
function getPriceOrNumberValue(raw: unknown): number {
  if (raw != null && typeof raw === 'object' && 'amount' in raw) {
    const obj = raw as { amount?: unknown; discountPercent?: unknown };
    const amount = Number(obj.amount);
    if (!Number.isFinite(amount)) return NaN;
    const discountPercent = Number(obj.discountPercent);
    const pct = Number.isFinite(discountPercent)
      ? Math.min(100, Math.max(0, discountPercent))
      : 0;
    return pct > 0 ? amount * (1 - pct / 100) : amount;
  }
  const n = Number(raw);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Returns the numeric value of a field for aggregation.
 * For structured price fields uses effective (discounted) price (expected revenue).
 * Plain numbers are used as-is.
 */
function getNumericValue(doc: Record<string, any>, field: string): number {
  return getPriceOrNumberValue(doc[field]);
}

/**
 * Computes a single metric on a dataset
 */
function computeMetric(docs: any[], metric: MetricDefinition): number | null {
  // Apply metric-level filter if specified
  let filtered = docs;
  if (metric.filter) {
    filtered = docs.filter((doc) => {
      const value = doc[metric.filter!.field];
      const comparable =
        value != null && typeof value === 'object' && 'amount' in value
          ? getPriceOrNumberValue(value)
          : typeof value === 'number' || value == null
            ? value
            : Number(value);
      switch (metric.filter!.operator) {
        case '==':
          return value === metric.filter!.value;
        case '!=':
          return value !== metric.filter!.value;
        case '>':
          return comparable > metric.filter!.value;
        case '<':
          return comparable < metric.filter!.value;
        case '>=':
          return comparable >= metric.filter!.value;
        case '<=':
          return comparable <= metric.filter!.value;
        default:
          return true;
      }
    });
  }

  switch (metric.operation) {
    case 'count':
      return filtered.length;

    case 'sum': {
      return filtered.reduce((sum, doc) => {
        const val = getNumericValue(doc, metric.field);
        return sum + (Number.isFinite(val) ? val : 0);
      }, 0);
    }

    case 'avg': {
      if (filtered.length === 0) return null;
      const sum = filtered.reduce((s, doc) => {
        const val = getNumericValue(doc, metric.field);
        return s + (Number.isFinite(val) ? val : 0);
      }, 0);
      return sum / filtered.length;
    }

    case 'min': {
      if (filtered.length === 0) return null;
      return filtered.reduce(
        (min, doc) => {
          const val = getNumericValue(doc, metric.field);
          if (!Number.isFinite(val)) return min;
          return min === null ? val : Math.min(min, val);
        },
        null as number | null
      );
    }

    case 'max': {
      if (filtered.length === 0) return null;
      return filtered.reduce(
        (max, doc) => {
          const val = getNumericValue(doc, metric.field);
          if (!Number.isFinite(val)) return max;
          return max === null ? val : Math.max(max, val);
        },
        null as number | null
      );
    }

    default:
      return null;
  }
}

/**
 * Generic business logic for aggregating entities
 */
function aggregateEntitiesLogicFactory(
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  config: AggregateConfig
) {
  return async function aggregateEntitiesLogic(
    data: AggregateRequest,
    context: {
      uid: string;
      userRole: UserRole;
      request: CallableRequest<AggregateRequest>;
    }
  ) {
    const db = getFirebaseAdminFirestore();
    const { userRole } = context;
    const isAdmin = hasRoleAccess(userRole, 'admin');

    // Validate that user can access the fields being aggregated
    const allFields = new Set<string>();

    config.metrics?.forEach((m) => allFields.add(m.field));
    config.groupBy?.forEach((g) => {
      allFields.add(g.field);
      g.metrics.forEach((m) => allFields.add(m.field));
    });

    for (const field of allFields) {
      if (!canAggregateField(field, documentSchema, isAdmin)) {
        throw new DoNotDevError(
          `Access denied: cannot aggregate field '${field}'`,
          'permission-denied'
        );
      }
    }

    // Build query with filters
    let query: FirebaseFirestore.Query = db.collection(collection);

    // Apply config-level filters
    const whereFilters = [...(config.where || []), ...(data.where || [])];
    for (const [field, operator, value] of whereFilters) {
      query = query.where(field, operator, value);
    }

    // Apply date range filter if specified
    if (data.dateRange) {
      const { field, start, end } = data.dateRange;
      if (start) {
        query = query.where(field, '>=', new Date(start));
      }
      if (end) {
        query = query.where(field, '<=', new Date(end));
      }
    }

    // W14: Cap document fetch to avoid OOM on large collections.
    // Aggregations on more than MAX_AGGREGATE_DOCS documents require server-side
    // Firestore COUNT/SUM queries (not yet used here) or pre-computed summaries.
    //
    // Architecture decision — full collection fetch for aggregations:
    // Firestore's free tier has no server-side aggregation beyond count().
    // Operations like sum, avg, min, and max require reading documents
    // client-side. This full-fetch approach is the only option without
    // paid extensions. For large collections (>10k docs), consumers should
    // use Firestore Extensions, BigQuery export, or pre-computed summary
    // documents updated via Cloud Functions triggers.
    // MAX_AGGREGATE_DOCS provides a safety limit to prevent OOM in Cloud
    // Functions (default 256MB memory).
    const MAX_AGGREGATE_DOCS = 10_000;
    const snapshot = await query.limit(MAX_AGGREGATE_DOCS).get();
    const docs: Record<string, any>[] = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    // Compute top-level metrics
    const metrics: Record<string, number | null> = {};
    if (config.metrics) {
      for (const metric of config.metrics) {
        metrics[metric.as] = computeMetric(docs, metric);
      }
    }

    // Compute grouped metrics
    const groups: Record<
      string,
      Record<string, Record<string, number | null>>
    > = {};
    if (config.groupBy) {
      for (const groupConfig of config.groupBy) {
        const groupedDocs = new Map<string, any[]>();

        // Group documents by field value
        for (const doc of docs) {
          const groupValue = String(doc[groupConfig.field] ?? 'null');
          if (!groupedDocs.has(groupValue)) {
            groupedDocs.set(groupValue, []);
          }
          groupedDocs.get(groupValue)!.push(doc);
        }

        // Compute metrics for each group
        const groupResults: Record<string, Record<string, number | null>> = {};
        for (const [groupValue, groupDocs] of groupedDocs) {
          groupResults[groupValue] = {};
          for (const metric of groupConfig.metrics) {
            groupResults[groupValue][metric.as] = computeMetric(
              groupDocs,
              metric
            );
          }
        }

        groups[groupConfig.field] = groupResults;
      }
    }

    return {
      metrics,
      groups,
      meta: {
        collection,
        totalDocs: docs.length,
        computedAt: new Date().toISOString(),
      },
    };
  };
}

/**
 * Generic function to aggregate entities from any Firestore collection.
 * Returns only computed metrics, never raw data.
 *
 * @param collection - The Firestore collection name
 * @param documentSchema - The Valibot schema (used for visibility checks)
 * @param config - Aggregation configuration (metrics, groupBy, filters)
 * @returns Firebase callable function
 *
 * @example
 * ```typescript
 * // Define analytics for cars collection
 * export const getCarsAnalytics = aggregateEntities('cars', carSchema, {
 *   metrics: [
 *     { field: '*', operation: 'count', as: 'total' },
 *     { field: 'price', operation: 'sum', as: 'totalValue' },
 *     { field: 'price', operation: 'avg', as: 'avgPrice' },
 *   ],
 *   groupBy: [
 *     {
 *       field: 'status',
 *       metrics: [
 *         { field: '*', operation: 'count', as: 'count' },
 *         { field: 'price', operation: 'sum', as: 'value' },
 *       ],
 *     },
 *   ],
 * });
 *
 * // Returns:
 * // {
 * //   metrics: { total: 150, totalValue: 4500000, avgPrice: 30000 },
 * //   groups: {
 * //     status: {
 * //       Available: { count: 80, value: 2400000 },
 * //       Reserved: { count: 20, value: 600000 },
 * //       Sold: { count: 50, value: 1500000 },
 * //     }
 * //   },
 * //   meta: { collection: 'cars', totalDocs: 150, computedAt: '...' }
 * // }
 * ```
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const aggregateEntities = (
  collection: string,
  documentSchema: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>,
  config: AggregateConfig
) => {
  const requestSchema = v.object({
    where: v.optional(v.array(v.tuple([v.string(), v.any(), v.any()]))),
    dateRange: v.optional(
      v.object({
        field: v.string(),
        start: v.optional(v.string()),
        end: v.optional(v.string()),
      })
    ),
  });

  return createBaseFunction(
    CRUD_CONFIG,
    requestSchema,
    'aggregate_entities',
    aggregateEntitiesLogicFactory(collection, documentSchema, config)
  );
};
