// packages/functions/src/firebase/auth/removeCustomClaims.ts

/**
 * @fileoverview Remove custom claims Firebase function
 * @description Firebase callable function for removing custom user claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { createBaseFunction } from '../baseFunction.js';
import { AUTH_CONFIG } from '../config/constants.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

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
 * Removes user's custom claims
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const removeCustomClaims = (
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
