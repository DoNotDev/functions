// packages/functions/src/supabase/crud/entityStore.ts

/**
 * @fileoverview In-process, entity-aware CRUD for server code (Edge Functions, jobs).
 * @description The HTTP CRUD handlers serve clients. Server code that already holds
 * a Supabase client (usually the service role) reads and writes through this store
 * instead of raw `.from()` queries: entity field names in and out (snake_case
 * columns stay behind the field mapper), unknown fields rejected, and the
 * publication filter applied by default (draft / deleted rows hidden, as the
 * database policy hides them from non-admin users; the service role bypasses that
 * policy, so the store re-applies it on reads).
 *
 * No role or visibility masking: the caller is trusted server code. Atomic
 * multi-table writes stay in SQL functions (`client.rpc`).
 *
 * @version 0.1.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';

import { HIDDEN_STATUSES } from '@donotdev/core/server';
import type { AnyEntity, InferEntityRow } from '@donotdev/core/server';
import { createEntityAwareMapper } from '@donotdev/supabase/server';

import { DoNotDevError } from '../../shared/utils.js';

/** Filter operators, same vocabulary as the list handler and the client CRUD. */
export type EntityStoreOperator =
  | '=='
  | '!='
  | '>'
  | '>='
  | '<'
  | '<='
  | 'in'
  | 'not-in'
  | 'array-contains'
  | 'array-contains-any';

/** `[field, operator, value]`; field is an entity field name. */
export type EntityStoreCondition = readonly [string, EntityStoreOperator, unknown];

/** Read options of {@link EntityStore.list} and {@link EntityStore.find}. */
export interface EntityStoreQuery {
  where?: readonly EntityStoreCondition[];
  /** Entity fields to read (default: every column). `id` is always read. */
  select?: readonly string[];
  orderBy?: readonly (readonly [string, 'asc' | 'desc'])[];
  limit?: number;
  /** Also return draft / deleted rows (default false). */
  includeHidden?: boolean;
}

/** Values written to a row: any subset of its fields; `null` clears a nullable column. */
export type EntityStoreValues<Row> = { [K in keyof Row]?: Row[K] | null };

/** Entity-aware CRUD bound to one entity and one Supabase client. */
export interface EntityStore<Row> {
  /** Rows matching the query. */
  list(query?: EntityStoreQuery): Promise<Row[]>;
  /** The single row matching the query, or null; more than one row is an error. */
  find(query: EntityStoreQuery): Promise<Row | null>;
  /** Row by id, or null (hidden rows only with `includeHidden`). */
  get(id: string, options?: Pick<EntityStoreQuery, 'includeHidden' | 'select'>): Promise<Row | null>;
  /** Inserts rows and returns them as stored (database defaults and triggers applied). */
  insert(values: readonly EntityStoreValues<Row>[]): Promise<Row[]>;
  /** Updates the rows matching `where` (hidden rows included) and returns them as stored. */
  update(where: readonly EntityStoreCondition[], patch: EntityStoreValues<Row>): Promise<Row[]>;
}

const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** The PostgREST filter builder methods the store uses. */
interface Filterable {
  eq(column: string, value: unknown): this;
  neq(column: string, value: unknown): this;
  gt(column: string, value: unknown): this;
  gte(column: string, value: unknown): this;
  lt(column: string, value: unknown): this;
  lte(column: string, value: unknown): this;
  in(column: string, values: readonly unknown[]): this;
  not(column: string, operator: string, value: unknown): this;
  contains(column: string, value: unknown): this;
  overlaps(column: string, value: unknown): this;
}

/** Result of an awaited PostgREST query. */
interface QueryResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * Untyped view of the PostgREST builder: the table name is only known at runtime,
 * and the generic builder types instantiate too deeply for a dynamic table.
 */
interface Query extends Filterable, PromiseLike<QueryResult> {
  select(columns: string): Query;
  order(column: string, options: { ascending: boolean }): Query;
  limit(count: number): Query;
}

interface Table {
  select(columns: string): Query;
  insert(rows: Record<string, unknown>[]): Query;
  update(values: Record<string, unknown>): Query;
}

/** PostgREST list literal for `not.in`: ("a","b"). */
function postgrestList(values: readonly unknown[]): string {
  return `(${values.map((v) => JSON.stringify(String(v))).join(',')})`;
}

function applyCondition<Q extends Filterable>(query: Q, column: string, operator: EntityStoreOperator, value: unknown): Q {
  const list = Array.isArray(value) ? value : [value];
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
      return query.in(column, list);
    case 'not-in':
      return query.not(column, 'in', postgrestList(list));
    case 'array-contains':
      return query.contains(column, [value]);
    case 'array-contains-any':
      // Postgres array columns only: PostgREST has no overlap operator for jsonb.
      return query.overlaps(column, list);
  }
}

/**
 * Creates an entity-aware CRUD store for server code.
 *
 * @param client - Supabase client the store runs with (service role in Edge Functions)
 * @param entity - Entity from `defineEntity()`; its collection is the table
 * @returns Store whose rows use the entity field names
 *
 * @example
 * ```typescript
 * import { createEntityStore } from '@donotdev/functions/supabase';
 * import { productEntity } from 'entities';
 *
 * const products = createEntityStore(supabaseAdmin, productEntity);
 * // Published products only (draft / deleted hidden by default)
 * const rows = await products.list({ where: [['id', 'in', ids]], select: ['name', 'sku'] });
 * ```
 *
 * @version 0.1.0
 * @since 0.5.0
 */
export function createEntityStore<E extends AnyEntity>(client: SupabaseClient, entity: E): EntityStore<InferEntityRow<E>> {
  type Row = InferEntityRow<E>;
  const fieldNames = Object.keys(entity.fields);
  const known = new Set(fieldNames);
  const mapper = createEntityAwareMapper(fieldNames);
  const table = entity.collection;
  const hasStatus = known.has('status');
  const from = (): Table => client.from(table) as unknown as Table;

  const column = (field: string): string => {
    if (!known.has(field) || !SAFE_FIELD_NAME.test(field)) {
      throw new DoNotDevError(`${entity.name}: unknown field '${field}'`, 'invalid-argument');
    }
    return mapper.toBackendField(field);
  };

  const toColumns = (values: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(values)) {
      if (value === undefined) continue;
      out[column(field)] = value;
    }
    return out;
  };

  const fromRows = (data: unknown): Row[] => ((data ?? []) as Record<string, unknown>[]).map((row) => mapper.fromBackendRow(row) as Row);

  const fail = (operation: string, error: { message: string }): never => {
    throw new DoNotDevError(`${operation} ${table}: ${error.message}`, 'internal');
  };

  const selectList = (select: readonly string[] | undefined): string =>
    select && select.length > 0 ? [...new Set(['id', ...select])].map(column).join(', ') : '*';

  const filtered = (query: Query, where: readonly EntityStoreCondition[], includeHidden: boolean | undefined): Query => {
    let q = query;
    for (const [field, operator, value] of where) q = applyCondition(q, column(field), operator, value);
    if (hasStatus && !includeHidden) q = q.not('status', 'in', postgrestList(HIDDEN_STATUSES));
    return q;
  };

  const list = async (query: EntityStoreQuery = {}): Promise<Row[]> => {
    let q = filtered(from().select(selectList(query.select)), query.where ?? [], query.includeHidden);
    for (const [field, direction] of query.orderBy ?? []) q = q.order(column(field), { ascending: direction === 'asc' });
    if (query.limit !== undefined) q = q.limit(query.limit);
    const { data, error } = await q;
    if (error) fail('list', error);
    return fromRows(data);
  };

  const find = async (query: EntityStoreQuery): Promise<Row | null> => {
    const rows = await list({ ...query, limit: 2 });
    if (rows.length > 1) throw new DoNotDevError(`${entity.name}: more than one row matches`, 'internal');
    return rows[0] ?? null;
  };

  return {
    list,
    find,
    get: (id, options) => find({ ...options, where: [['id', '==', id]] }),

    async insert(values) {
      if (values.length === 0) return [];
      const { data, error } = await from()
        .insert(values.map((v) => toColumns(v as Record<string, unknown>)))
        .select('*');
      if (error) fail('insert', error);
      return fromRows(data);
    },

    async update(where, patch) {
      if (where.length === 0) throw new DoNotDevError(`${entity.name}: update without a condition`, 'invalid-argument');
      const { data, error } = await filtered(from().update(toColumns(patch as Record<string, unknown>)), where, true).select('*');
      if (error) fail('update', error);
      return fromRows(data);
    },
  };
}
