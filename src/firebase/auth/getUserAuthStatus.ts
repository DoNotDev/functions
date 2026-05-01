// packages/functions/src/firebase/auth/getUserAuthStatus.ts

/**
 * @fileoverview Get user auth status Firebase function
 * @description Firebase callable function for retrieving user authentication status
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

const getUserAuthStatusSchema = v.object({});

export type GetUserAuthStatusRequest = v.InferOutput<
  typeof getUserAuthStatusSchema
>;
export type GetUserAuthStatusResponse = {
  uid: string;
  email?: string;
  emailVerified: boolean;
  customClaims: Record<string, any>;
  disabled: boolean;
};

/**
 * Business logic for getting user auth status
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
async function getUserAuthStatusLogic(
  data: GetUserAuthStatusRequest,
  context: {
    uid: string;
    request: CallableRequest<GetUserAuthStatusRequest>;
  }
) {
  const user = await getFirebaseAdminAuth().getUser(context.uid);

  return {
    uid: user.uid,
    email: user.email,
    emailVerified: user.emailVerified,
    customClaims: user.customClaims || {},
    disabled: user.disabled,
  };
}

/**
 * Gets user authentication status
 * Base function handles all common concerns automatically
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const getUserAuthStatus = (
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>
): CallableFunction<
  GetUserAuthStatusRequest,
  Promise<GetUserAuthStatusResponse>
> => {
  const schema = customSchema || getUserAuthStatusSchema;
  return createBaseFunction(
    AUTH_CONFIG,
    schema,
    'get_user_auth_status',
    getUserAuthStatusLogic
  );
};
