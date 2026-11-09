// packages/functions/src/vercel/api/auth/remove-custom-claims.ts

/**
 * @fileoverview Remove custom claims API handler
 * @description Vercel API route for removing custom user claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import type { NextApiRequest, NextApiResponse } from 'next';

import { handleError } from '../../../shared/errorHandling.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);
    const { claimsToRemove } = req.body;

    if (!Array.isArray(claimsToRemove)) {
      throw handleError(new Error('claimsToRemove must be an array'));
    }

    const { getFirebaseAdminAuth } = await import('@donotdev/firebase/server');
    const user = await getFirebaseAdminAuth().getUser(uid);
    const currentClaims = user.customClaims || {};

    // Remove specified claims
    const updatedClaims = { ...currentClaims };
    claimsToRemove.forEach((claim) => {
      delete updatedClaims[claim];
    });

    await getFirebaseAdminAuth().setCustomUserClaims(uid, updatedClaims);

    return res.status(200).json({ success: true, customClaims: updatedClaims });
  } catch (error) {
    throw handleError(error);
  }
}
