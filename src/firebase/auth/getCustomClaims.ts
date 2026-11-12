// packages/functions/src/firebase/auth/getCustomClaims.ts

/**
 * @fileoverview Get custom claims Firebase function
 * @description Firebase callable function for retrieving custom user claims
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

const getCustomClaimsSchema = v.object({});

type GetCustomClaimsRequest = v.InferOutput<typeof getCustomClaimsSchema>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: not yet narrowed (any-audit 2026-11-11 follow-up)
type GetCustomClaimsResponse = { customClaims: Record<string, any> };

/**
 * Business logic for getting custom claims
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function getCustomClaimsLogic(
  data: GetCustomClaimsRequest,
  context: {
    uid: string;
    request: CallableRequest<GetCustomClaimsRequest>;
  }
) {
  const user = await getFirebaseAdminAuth().getUser(context.uid);
  return { customClaims: user.customClaims || {} };
}

/**
 * Gets user's custom claims
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const getCustomClaims = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- why: accepts schemas of any output type; v.GenericSchema would make InferOutput unknown for callers (breaking)
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
): CallableFunction<
  GetCustomClaimsRequest,
  Promise<GetCustomClaimsResponse>
> => {
  const schema = customSchema || getCustomClaimsSchema;
  return createBaseFunction(
    AUTH_CONFIG,
    schema,
    'get_custom_claims',
    getCustomClaimsLogic
  );
};
