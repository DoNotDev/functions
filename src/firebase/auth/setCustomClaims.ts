// packages/functions/src/firebase/auth/setCustomClaims.ts

/**
 * @fileoverview Set custom claims Firebase function
 * @description Firebase callable function for setting custom user claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import * as v from 'valibot';

import {
  getFirebaseAdminAuth,
  getFirebaseAdminFirestore,
} from '@donotdev/firebase/server';

import { createBaseFunction } from '../baseFunction.js';
import { AUTH_CONFIG } from '../config/constants.js';

import type {
  CallableFunction,
  CallableRequest,
} from 'firebase-functions/v2/https';

/**
 * Claim keys that must NEVER be self-assignable — privilege escalation vectors.
 */
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
]);

const setCustomClaimsSchema = v.object({
  customClaims: v.record(v.string(), v.any()),
  idempotencyKey: v.optional(v.string()),
});

export type SetCustomClaimsRequest = v.InferOutput<
  typeof setCustomClaimsSchema
>;
export type SetCustomClaimsResponse = {
  success: boolean;
  customClaims: Record<string, any>;
};

export interface SetCustomClaimsOptions {
  /** Explicit allowlist of claim keys users may set on themselves. Required. */
  allowedClaimKeys: string[];
  customSchema?: v.BaseSchema<unknown, any, v.BaseIssue<unknown>>;
}

/**
 * Business logic for setting custom claims
 * Base function handles: validation, auth, rate limiting, monitoring
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
function createSetCustomClaimsLogic(allowedKeys: Set<string>) {
  return async function setCustomClaimsLogic(
    data: SetCustomClaimsRequest,
    context: {
      uid: string;
      request: CallableRequest<SetCustomClaimsRequest>;
    }
  ) {
    const { customClaims, idempotencyKey } = data;

    if (!customClaims || typeof customClaims !== 'object') {
      throw new Error('customClaims must be an object');
    }

    const disallowedKeys = Object.keys(customClaims).filter(
      (k) => !allowedKeys.has(k)
    );
    if (disallowedKeys.length > 0) {
      throw new Error(`Claim keys not allowed: ${disallowedKeys.join(', ')}`);
    }

    // W17: Validate idempotency key to prevent oversized or malformed inputs.
    if (idempotencyKey !== undefined) {
      if (
        typeof idempotencyKey !== 'string' ||
        idempotencyKey.length === 0 ||
        idempotencyKey.length > 256
      ) {
        throw new Error(
          'idempotencyKey must be a non-empty string of at most 256 characters'
        );
      }
      if (!/^[\w\-.:@]+$/.test(idempotencyKey)) {
        throw new Error(
          'idempotencyKey contains invalid characters (allowed: alphanumeric, -, _, ., :, @)'
        );
      }
    }

    // C9: Atomic idempotency check — reserve key in a transaction to eliminate TOCTOU race.
    if (idempotencyKey) {
      const db = getFirebaseAdminFirestore();
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`claims_${idempotencyKey}`);

      let existingResult: unknown = undefined;
      let alreadyProcessed = false;

      await db.runTransaction(async (tx) => {
        const idempotencyDoc = await tx.get(idempotencyRef);
        if (idempotencyDoc.exists) {
          existingResult = idempotencyDoc.data()?.result;
          alreadyProcessed = true;
          return;
        }
        tx.set(idempotencyRef, {
          processing: true,
          reservedAt: new Date().toISOString(),
        });
      });

      if (alreadyProcessed) {
        return existingResult as {
          success: boolean;
          customClaims: Record<string, any>;
        };
      }
    }

    const user = await getFirebaseAdminAuth().getUser(context.uid);
    const currentClaims = user.customClaims || {};

    // Merge with existing claims
    const updatedClaims = { ...currentClaims, ...customClaims };

    await getFirebaseAdminAuth().setCustomUserClaims(
      context.uid,
      updatedClaims
    );

    const result = { success: true, customClaims: updatedClaims };

    // Store result for idempotency if key provided
    if (idempotencyKey) {
      const db = getFirebaseAdminFirestore();
      const idempotencyRef = db
        .collection('idempotency')
        .doc(`claims_${idempotencyKey}`);
      await idempotencyRef.set({
        result,
        processedAt: new Date().toISOString(),
        processedBy: context.uid,
      });
    }

    return result;
  };
}

/**
 * Sets custom claims for a user, restricted to allowed keys.
 * Consumers MUST specify which claim keys are self-assignable.
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */
export const setCustomClaims = (
  options: SetCustomClaimsOptions
): CallableFunction<
  SetCustomClaimsRequest,
  Promise<SetCustomClaimsResponse>
> => {
  const allowedKeys = new Set(options.allowedClaimKeys);

  // Fail fast if consumer accidentally allows a privilege key
  for (const key of allowedKeys) {
    if (BLOCKED_CLAIM_KEYS.has(key)) {
      throw new Error(
        `Claim key "${key}" is blocked — it is a privilege-escalation vector and cannot be self-assigned.`
      );
    }
  }

  const schema = options.customSchema || setCustomClaimsSchema;
  return createBaseFunction(
    AUTH_CONFIG,
    schema,
    'set_custom_claims',
    createSetCustomClaimsLogic(allowedKeys)
  );
};
