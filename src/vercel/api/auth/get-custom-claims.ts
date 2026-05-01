// packages/functions/src/vercel/api/auth/get-custom-claims.ts

/**
 * @fileoverview Get custom claims API handler
 * @description Vercel API route for retrieving custom user claims
 *
 * @version 0.1.0
 * @since 0.0.1
 * @author AMBROISE PARK Consulting
 */

import { getFirebaseAdminAuth } from '@donotdev/firebase/server';

import { handleError } from '../../../shared/errorHandling.js';
import { verifyAuthToken } from '../../../shared/utils/internal/auth.js';

import type { NextApiRequest, NextApiResponse } from 'next';

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
    const user = await getFirebaseAdminAuth().getUser(uid);
    return res.status(200).json({ customClaims: user.customClaims || {} });
  } catch (error) {
    throw handleError(error);
  }
}
