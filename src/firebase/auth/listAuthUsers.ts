// packages/functions/src/firebase/auth/listAuthUsers.ts

/**
 * @fileoverview List auth users Firebase function
 * @description Admin-only Firebase callable listing every auth account (email,
 * verification, sign-in dates) straight from Firebase Auth (Admin SDK `listUsers`).
 *
 * @version 0.1.0
 * @since 0.3.3
 * @author AMBROISE PARK Consulting
 */

import type { UserRecord } from 'firebase-admin/auth';
import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';
import * as v from 'valibot';

import type {
  AuthUserSummary,
  ListAuthUsersResponse,
} from '@donotdev/core/server';
import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { createBaseFunction } from '../baseFunction.js';
import { AUTH_CONFIG } from '../config/constants.js';

const listAuthUsersSchema = v.object({});

export type ListAuthUsersRequest = v.InferOutput<typeof listAuthUsersSchema>;

/** Page size of Admin SDK `listUsers` (its maximum). */
const PER_PAGE = 1000;

/** Firebase metadata time (UTC string) as ISO 8601; null when absent. */
function toIso(time: string | null | undefined): string | null {
  return time ? new Date(time).toISOString() : null;
}

/**
 * Map a Firebase user record to an {@link AuthUserSummary}.
 * Firebase records no confirmation time: a verified address carries the account
 * creation time as `emailConfirmedAt`; an unverified one, null.
 */
function toAuthUserSummary(user: UserRecord): AuthUserSummary {
  const createdAt = toIso(user.metadata.creationTime)!;
  return {
    id: user.uid,
    email: user.email ?? null,
    emailConfirmedAt: user.emailVerified ? createdAt : null,
    createdAt,
    lastSignInAt: toIso(user.metadata.lastSignInTime),
    displayName: user.displayName ?? null,
  };
}

/**
 * Business logic: pages through Admin SDK `listUsers` (1000 per page) until the last page.
 * Base function handles: validation, auth, admin role check, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.3.3
 * @author AMBROISE PARK Consulting
 */
async function listAuthUsersLogic(
  _data: ListAuthUsersRequest,
  _context: { uid: string; request: CallableRequest<ListAuthUsersRequest> }
): Promise<ListAuthUsersResponse> {
  const auth = getFirebaseAdminAuth();
  const users: AuthUserSummary[] = [];
  let pageToken: string | undefined;
  do {
    const page = await auth.listUsers(PER_PAGE, pageToken);
    users.push(...page.users.map(toAuthUserSummary));
    pageToken = page.pageToken;
  } while (pageToken);
  return { users };
}

/**
 * Lists every auth user. Admin only: callers without the `admin` (or `super`) role
 * claim are refused (the base function rejects them before the listing runs).
 * Client side: `useAuthUsers()` / `useAuth('listUsers')` from `@donotdev/auth`
 * (the Firebase auth provider calls the callable named `listAuthUsers`).
 *
 * @example
 * ```typescript
 * // functions/src/index.ts
 * import { listAuthUsers as frameworkListAuthUsers } from '@donotdev/functions/firebase';
 * export const listAuthUsers = frameworkListAuthUsers();
 * ```
 *
 * @version 0.1.0
 * @since 0.3.3
 * @author AMBROISE PARK Consulting
 */
export const listAuthUsers = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: same signature as the sibling auth factories (accepts schemas of any output type)
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
): CallableFunction<ListAuthUsersRequest, Promise<ListAuthUsersResponse>> => {
  const schema = customSchema || listAuthUsersSchema;
  return createBaseFunction(
    AUTH_CONFIG,
    schema,
    'list_auth_users',
    listAuthUsersLogic,
    'admin'
  );
};
