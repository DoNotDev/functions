// packages/functions/src/supabase/auth/listAuthUsers.ts

/**
 * @fileoverview List Auth Users Supabase Edge Function
 * @description Admin-only: lists every auth account (email, confirmation, sign-in dates)
 * straight from Supabase Auth (`auth.admin.listUsers`). No view, no copied table.
 *
 * @version 0.1.0
 * @since 0.3.3
 * @author AMBROISE PARK Consulting
 */

import type { User } from '@supabase/supabase-js';
import * as v from 'valibot';

import type {
  AuthUserSummary,
  ListAuthUsersResponse,
} from '@donotdev/core/server';

import { createSupabaseHandler } from '../baseFunction.js';

// =============================================================================
// Schema
// =============================================================================

const listAuthUsersSchema = v.object({});

/** Page size of `auth.admin.listUsers` (the GoTrue maximum). */
const PER_PAGE = 1000;

// =============================================================================
// Mapping
// =============================================================================

/** A user_metadata value when it is a string. */
function metaString(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Map a Supabase auth user to an {@link AuthUserSummary}. `displayName` reads
 * `user_metadata.full_name`, then `name`, like the Supabase client provider.
 */
function toAuthUserSummary(user: User): AuthUserSummary {
  const meta = (user.user_metadata ?? {}) as Record<string, unknown>;
  return {
    id: user.id,
    email: user.email ?? null,
    emailConfirmedAt: user.email_confirmed_at ?? null,
    createdAt: user.created_at,
    lastSignInAt: user.last_sign_in_at ?? null,
    displayName: metaString(meta, 'full_name') ?? metaString(meta, 'name'),
  };
}

// =============================================================================
// Handler
// =============================================================================

/**
 * Create the admin-only Supabase Edge Function handler that lists every auth user.
 * Pages through `auth.admin.listUsers` (1000 per page) until the last page.
 * Callers without `app_metadata.role` admin (or super) get 403.
 * Client side: `useAuthUsers()` / `useAuth('listUsers')` from `@donotdev/auth`.
 *
 * @returns `(req: Request) => Promise<Response>` handler answering `{ users }`
 *
 * @example
 * ```typescript
 * // supabase/functions/list-auth-users/index.ts
 * import { createListAuthUsers } from '@donotdev/functions/supabase';
 * Deno.serve(createListAuthUsers());
 * ```
 *
 * @version 0.1.0
 * @since 0.3.3
 */
export function createListAuthUsers(): (req: Request) => Promise<Response> {
  return createSupabaseHandler(
    'list-auth-users',
    listAuthUsersSchema,
    async (_data, ctx): Promise<ListAuthUsersResponse> => {
      const users: AuthUserSummary[] = [];
      for (let page = 1; ; page++) {
        const { data, error } = await ctx.supabaseAdmin.auth.admin.listUsers({
          page,
          perPage: PER_PAGE,
        });
        if (error) throw error;
        users.push(...data.users.map(toAuthUserSummary));
        if (data.users.length < PER_PAGE) return { users };
      }
    },
    'admin'
  );
}
