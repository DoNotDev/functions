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
 * No role or visibility masking: the caller is trusted server code. Writes are
 * still validated: each insert row / patch against the schema of its resulting
 * status (the CRUD rules: `create`, `draft` or `update`; a patch reads the matched
 * rows first, their stored status counts), and the parse output is what is written.
 * A caller-chosen insert `id` is kept. Insert and patch types come from the descriptor (`CreateInput`,
 * `DraftInput`, `UpdatePatch`: write classes `program`, `user`, `derived`).
 * Atomic multi-table writes stay in SQL functions (`client.rpc`).
 *
 * @version 0.2.0
 * @since 0.5.0
 * @author AMBROISE PARK Consulting
 */

import type { SupabaseClient } from '@supabase/supabase-js';


import {
  createSchemas,
  HIDDEN_STATUSES,
  prepareCreate,
  prepareRemove,
  prepareUpdate,
} from '@donotdev/core/server';
import type {
  AnyEntity,
  CreateInput,
  DraftInput,
  InferEntityRow,
  UpdatePatch,
} from '@donotdev/core/server';
import { createEntityAwareMapper } from '@donotdev/supabase/server';

import { writtenOf } from '../../shared/crud/written.js';
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

/**
 * Loose write values: any subset of the row's fields; `null` clears a nullable column.
 * Default insert / patch type of {@link EntityStore}; `createEntityStore` narrows
 * them to the descriptor types.
 */
export type EntityStoreValues<Row> = { [K in keyof Row]?: Row[K] | null };

/**
 * Insert row of an entity store: a create, or a draft (`status: 'draft'`), with an
 * optional caller-chosen `id` (write class never, but a minted id is allowed on
 * insert: other rows may reference it).
 */
export type EntityStoreInsert<E extends AnyEntity> = (CreateInput<E> | DraftInput<E>) & { id?: string };

/** Patch of an entity store: an update, or a draft write (`status: 'draft'`). */
export type EntityStorePatch<E extends AnyEntity> = UpdatePatch<E> | DraftInput<E>;

/**
 * Entity-aware CRUD bound to one entity and one Supabase client.
 *
 * @template Row - Stored row
 * @template Insert - Insert row type
 * @template Patch - Update patch type
 */
export interface EntityStore<Row, Insert = EntityStoreValues<Row>, Patch = EntityStoreValues<Row>> {
  /** Rows matching the query. */
  list(query?: EntityStoreQuery): Promise<Row[]>;
  /** The single row matching the query, or null; more than one row is an error. */
  find(query: EntityStoreQuery): Promise<Row | null>;
  /** Row by id, or null (hidden rows only with `includeHidden`). */
  get(id: string, options?: Pick<EntityStoreQuery, 'includeHidden' | 'select'>): Promise<Row | null>;
  /**
   * Validates and inserts rows (CRUD create rules, `prepareCreate`); returns them as
   * stored (database defaults and triggers applied). Unknown fields are logged, not
   * written. A row's string `id` is kept (a minted id other rows reference); without
   * one the database mints it.
   */
  insert(values: readonly Insert[]): Promise<Row[]>;
  /**
   * Validates the patch against each row matching `where` (hidden rows included; CRUD
   * update rules, `prepareUpdate` on each stored row), then updates those rows; returns
   * them as stored. Unknown fields are logged, not written.
   */
  update(where: readonly EntityStoreCondition[], patch: Patch): Promise<Row[]>;
  /**
   * Logical delete (CRUD rule 3) of the rows matching `where`: the update
   * `{ status: 'deleted' }`. The hard delete is not part of the store.
   */
  remove(where: readonly EntityStoreCondition[]): Promise<void>;
}

const SAFE_FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_]*$/;

/** The PostgREST filter builder methods the store uses. */
export interface Filterable {
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
 * @returns Store whose rows use the entity field names; writes validated per status
 * @throws DoNotDevError `invalid-argument` on an unknown field or a write that fails its schema
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
 * @version 0.2.0
 * @since 0.5.0
 */
export function createEntityStore<E extends AnyEntity>(
  client: SupabaseClient,
  entity: E
): EntityStore<InferEntityRow<E>, EntityStoreInsert<E>, EntityStorePatch<E>> {
  type Row = InferEntityRow<E>;
  const schemas = createSchemas(entity);
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

  const insertRow = (row: object): Record<string, unknown> => {
    const values = row as Record<string, unknown>;
    const written = writtenOf(prepareCreate(schemas, values), table, 'insert');
    // The rules never write `id`: a caller-chosen id is kept.
    return toColumns(typeof values.id === 'string' ? { ...written, id: values.id } : written);
  };

  /** The patch as written to one stored row (CRUD update rules). */
  const patchFor = (patch: Record<string, unknown>, stored: Record<string, unknown>): Record<string, unknown> =>
    writtenOf(prepareUpdate(schemas, { id: String(stored.id), patch, stored }), table, 'update');

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
        .insert(values.map(insertRow))
        .select('*');
      if (error) fail('insert', error);
      return fromRows(data);
    },

    async update(where, patch) {
      if (where.length === 0) throw new DoNotDevError(`${entity.name}: update without a condition`, 'invalid-argument');
      const values = patch as Record<string, unknown>;
      // Each stored row gives the patch its status and a published draft its record.
      const targets = await list({ where, includeHidden: true });
      if (targets.length === 0) return [];
      let written: Record<string, unknown> = {};
      for (const row of targets) written = patchFor(values, row as Record<string, unknown>);
      // Only the validated rows: `where` again (concurrency guards) and their ids.
      const ids = targets.map((row) => (row as Record<string, unknown>).id);
      const { data, error } = await filtered(from().update(toColumns(written)), [...where, ['id', 'in', ids]], true).select('*');
      if (error) fail('update', error);
      return fromRows(data);
    },

    async remove(where) {
      if (where.length === 0) throw new DoNotDevError(`${entity.name}: remove without a condition`, 'invalid-argument');
      const targets = await list({ where, includeHidden: true, select: ['id'] });
      const first = targets[0] as Record<string, unknown> | undefined;
      if (!first) return;
      // CRUD rule 3 (core/schemas crud/update `prepareRemove`): the same patch for every row.
      const written = writtenOf(prepareRemove(schemas, String(first.id)), table, 'remove');
      const ids = targets.map((row) => (row as Record<string, unknown>).id);
      const { error } = await filtered(from().update(toColumns(written)), [...where, ['id', 'in', ids]], true).select('id');
      if (error) fail('remove', error);
    },
  };
}
