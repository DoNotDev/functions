// packages/functions/src/vercel/api/auth/get-user-auth-status.ts

/**
 * @fileoverview Get user authentication status API handler
 * @description Vercel API route for retrieving user authentication status
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

    return res.status(200).json({
      uid: user.uid,
      email: user.email,
      emailVerified: user.emailVerified,
      customClaims: user.customClaims || {},
      disabled: user.disabled,
    });
  } catch (error) {
    throw handleError(error);
  }
}
