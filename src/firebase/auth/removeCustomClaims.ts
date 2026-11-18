// packages/functions/src/firebase/auth/removeCustomClaims.ts

/**
 * @fileoverview Remove custom claims Firebase function
 * @description Firebase callable function for removing custom user claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';
import * as v from 'valibot';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { createBaseFunction } from '../baseFunction.js';
import { AUTH_CONFIG } from '../config/constants.js';

/** Claim keys users must not remove: access and identity integrity. */
const BLOCKED_CLAIM_KEYS = new Set([
  'admin',
  'isAdmin',
  'isSuper',
  'isSuperAdmin',
  'role',
  'roles',
  'permissions',
  'superuser',
  'moderator',
  'staff',
  'elevated',
  'plan',
  'tier',
  'subscription',
  'provider',
  'providers',
  'sub',
  'iss',
  'aud',
]);

const removeCustomClaimsSchema = v.object({
  claimsToRemove: v.pipe(
    v.array(v.string()),
    v.minLength(1, 'At least one claim must be specified')
  ),
});

export type RemoveCustomClaimsRequest = v.InferOutput<
  typeof removeCustomClaimsSchema
>;
export type RemoveCustomClaimsResponse = {
  success: boolean;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: exported signature; narrowing it is a breaking change for importers (deferred to a major, any-audit 2026-11-11)
  customClaims: Record<string, any>;
};

/**
 * Business logic for removing custom claims
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function removeCustomClaimsLogic(
  data: RemoveCustomClaimsRequest,
  context: {
    uid: string;
    request: CallableRequest<RemoveCustomClaimsRequest>;
  }
) {
  const { claimsToRemove } = data;

  const blocked = claimsToRemove.filter((key) => BLOCKED_CLAIM_KEYS.has(key));
  if (blocked.length > 0) {
    throw new Error(
      `Protected claims cannot be removed: ${blocked.join(', ')}`
    );
  }

  const user = await getFirebaseAdminAuth().getUser(context.uid);
  const currentClaims = user.customClaims || {};

  // Remove specified claims
  const updatedClaims = { ...currentClaims };
  claimsToRemove.forEach((claim) => {
    delete updatedClaims[claim];
  });

  await getFirebaseAdminAuth().setCustomUserClaims(context.uid, updatedClaims);

  return { success: true, customClaims: updatedClaims };
}

/**
 * Removes user's custom claims, except protected access and identity claims.
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const removeCustomClaims = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: accepts schemas of any output type; v.GenericSchema would make InferOutput unknown for callers (breaking)
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
): CallableFunction<
  RemoveCustomClaimsRequest,
  Promise<RemoveCustomClaimsResponse>
> => {
  const schema = customSchema || removeCustomClaimsSchema;
  return createBaseFunction(
    AUTH_CONFIG,
    schema,
    'remove_custom_claims',
    removeCustomClaimsLogic
  );
};
