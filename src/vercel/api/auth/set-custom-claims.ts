// packages/functions/src/vercel/api/auth/set-custom-claims.ts

/**
 * @fileoverview Set custom claims API handler
 * @description Vercel API route for setting custom user claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';

import type { NextApiRequest, NextApiResponse } from 'next';

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

export interface SetCustomClaimsHandlerOptions {
  /** Explicit allowlist of claim keys users may set on themselves. Required. */
  allowedClaimKeys: string[];
}

/**
 * Factory that returns a set-custom-claims handler scoped to allowed keys.
 * Consumers MUST specify which claim keys are self-assignable.
 */
export function createSetCustomClaimsHandler(
  options: SetCustomClaimsHandlerOptions
) {
  const allowedKeys = new Set(options.allowedClaimKeys);

  // Fail fast if consumer accidentally allows a privilege key
  for (const key of allowedKeys) {
    if (BLOCKED_CLAIM_KEYS.has(key)) {
      throw new Error(
        `Claim key "${key}" is blocked — it is a privilege-escalation vector and cannot be self-assigned.`
      );
    }
  }

  return async function handler(req: NextApiRequest, res: NextApiResponse) {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
      const uid = await verifyAuthToken(req);
      const { customClaims } = req.body;

      if (!customClaims || typeof customClaims !== 'object') {
        throw handleError(new Error('customClaims must be an object'));
      }

      const disallowedKeys = Object.keys(customClaims).filter(
        (k) => !allowedKeys.has(k)
      );
      if (disallowedKeys.length > 0) {
        throw handleError(
          new Error(`Claim keys not allowed: ${disallowedKeys.join(', ')}`)
        );
      }

      const user = await getFirebaseAdminAuth().getUser(uid);
      const currentClaims = user.customClaims || {};

      const updatedClaims = { ...currentClaims, ...customClaims };

      await getFirebaseAdminAuth().setCustomUserClaims(uid, updatedClaims);

      return res
        .status(200)
        .json({ success: true, customClaims: updatedClaims });
    } catch (error) {
      throw handleError(error);
    }
  };
}
