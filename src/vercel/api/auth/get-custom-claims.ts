// packages/functions/src/vercel/api/auth/get-custom-claims.ts

/**
 * @fileoverview Get custom claims API handler
 * @description Vercel API route for retrieving custom user claims
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
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    // C1: verify JWT — previously only checked header presence.
    const uid = await verifyAuthToken(req);
    const { getFirebaseAdminAuth } = await import('@donotdev/firebase/server');
    const user = await getFirebaseAdminAuth().getUser(uid);
    return res.status(200).json({ customClaims: user.customClaims || {} });
  } catch (error) {
    throw handleError(error);
  }
}
